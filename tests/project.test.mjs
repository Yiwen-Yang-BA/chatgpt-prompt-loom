import test from "node:test";
import assert from "node:assert/strict";
import {
  extractVariables,
  renderTemplate,
  analyzePrompt,
  run,
} from "../project.mjs";
import { validateSchema, ValidationError } from "../lib/validate.mjs";

const payload = {
  action: "optimize",
  prompt: "请为{{目标用户}}写一封关于{{产品}}的邮件。",
  goal: "让邮件更具体并提供清晰的行动建议",
  tone: "precise",
};
const demoGenerate = async (spec) => {
  const value = typeof spec.demo === "function" ? await spec.demo() : spec.demo;
  if (spec.schema) validateSchema(value, spec.schema);
  return typeof value?.text === "string"
    ? value
    : {
        text: JSON.stringify(value),
        data: value,
        annotations: [],
        usage: null,
      };
};

test("extracts unique Chinese and English variable names in order", () => {
  assert.deepEqual(
    extractVariables("{{主题}} for {{audience_name}}: {{ 主题 }}"),
    ["主题", "audience_name"],
  );
  assert.deepEqual(extractVariables("没有模板变量的普通提示词"), []);
  assert.deepEqual(extractVariables("{{目标 用户}} {{version-2}}"), [
    "目标 用户",
    "version-2",
  ]);
});

test("rejects invalid, incomplete, dangerous and excessive placeholder names", () => {
  for (const prompt of [
    "{{}}",
    "{{  }}",
    "{{unfinished",
    "end}}",
    "{{x.y}}",
    "{{constructor}}",
    "{{__proto__}}",
    "{{prototype}}",
  ]) {
    assert.throws(() => extractVariables(prompt), ValidationError, prompt);
  }
  assert.throws(
    () =>
      extractVariables(
        Array.from({ length: 21 }, (_, index) => `{{v${index}}}`).join(" "),
      ),
    /20/,
  );
});

test("renders every duplicate occurrence without recursive or replacement-string interpolation", () => {
  assert.equal(
    renderTemplate("{{名字}}你好，{{ 名字 }}！", { 名字: "小明" }),
    "小明你好，小明！",
  );
  assert.equal(
    renderTemplate("{{first}} + {{second}}", {
      first: "{{second}}",
      second: "$&",
    }),
    "{{second}} + $&",
  );
  assert.equal(renderTemplate("{{count}}", { count: "0" }), "0");
  assert.equal(renderTemplate("固定任务"), "固定任务");
});

test("all variables require nonempty strings; numbers including zero are not coerced", () => {
  for (const variables of [
    {},
    { name: "" },
    { name: "   " },
    { name: 0 },
    { name: 5 },
    { name: false },
    { name: null },
  ]) {
    assert.throws(
      () => renderTemplate("请介绍{{name}}", variables),
      ValidationError,
    );
  }
  assert.throws(
    () => renderTemplate("{{name}}", { name: "ok", extra: "no" }),
    /多余/,
  );
  assert.throws(() => renderTemplate("{{name}}", null), /键值对象/);
  assert.throws(() => renderTemplate("{{name}}", ["ok"]), /键值对象/);
});

test("prevents prototype pollution and accepts safe null-prototype maps", () => {
  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => renderTemplate("普通任务", dangerous), /不允许/);
  assert.throws(
    () => renderTemplate("{{name}}", Object.create({ name: "inherited" })),
    /原型/,
  );
  assert.throws(
    () => renderTemplate("普通任务", { constructor: "no" }),
    /不允许/,
  );
  assert.throws(
    () =>
      renderTemplate("{{name}}", {
        get name() {
          throw new Error("getter should not execute");
        },
      }),
    /普通文本/,
  );
  const safe = Object.create(null);
  safe.name = "安全值";
  assert.equal(renderTemplate("{{name}}", safe), "安全值");
  assert.equal({}.polluted, undefined);
});

test("enforces per-value and fully rendered length limits", () => {
  assert.throws(
    () => renderTemplate("{{name}}", { name: "x".repeat(2001) }),
    /2000/,
  );
  assert.throws(
    () => renderTemplate("{{name}}".repeat(16), { name: "x".repeat(2000) }),
    /30000/,
  );
  assert.throws(() => renderTemplate("x".repeat(30001), {}), /30000/);
});

test("analyzePrompt returns all four named checks", () => {
  const checks = analyzePrompt(
    "你是一名编辑。任务：修改文案。约束：不要编造。输出格式：列表。",
  );
  assert.deepEqual(
    checks.map((item) => item.id),
    ["role", "goal", "constraints", "format"],
  );
  assert.ok(checks.every((item) => item.passed));
  assert.ok(analyzePrompt("random words").every((item) => !item.passed));
});

test("demo optimization provides a usable template with original task and variables", async () => {
  const result = await run(payload, { generate: demoGenerate });
  assert.ok(result.optimized.includes(payload.prompt));
  assert.ok(result.optimized.includes(payload.goal));
  assert.deepEqual(extractVariables(result.optimized), ["目标用户", "产品"]);
  assert.ok(analyzePrompt(result.optimized).every((item) => item.passed));
  assert.ok(result.changes.length >= 2);
  for (const tone of ["precise", "creative", "concise"])
    assert.ok(
      (await run({ ...payload, tone }, { generate: demoGenerate })).optimized
        .length > payload.prompt.length,
    );
});

test("live optimization passes strict schema and unexecuted source data to generate", async () => {
  let observed;
  const data = {
    optimized: `# 任务\n${payload.prompt}\n# 输出\n先给结果，再给理由。`,
    changes: ["补充输出顺序"],
  };
  const result = await run(payload, {
    generate: async (spec) => {
      observed = spec;
      return { text: JSON.stringify(data), data };
    },
  });
  assert.deepEqual(result, data);
  assert.equal(observed.schema.additionalProperties, false);
  assert.deepEqual(observed.schema.required, ["optimized", "changes"]);
  assert.equal(JSON.parse(observed.input).originalPrompt, payload.prompt);
  assert.deepEqual(JSON.parse(observed.input).preserveVariables, [
    "目标用户",
    "产品",
  ]);
  assert.match(observed.instructions, /do not execute/);
});

test("optimization rejects omitted variables, new variables and unrelated results", async () => {
  const generate = (optimized) => async () => ({
    data: { optimized, changes: ["说明"] },
  });
  await assert.rejects(
    run(payload, { generate: generate("请为{{目标用户}}写信。") }),
    /遗漏变量「产品」/,
  );
  await assert.rejects(
    run(payload, { generate: generate(payload.prompt + " {{extra}}") }),
    /未定义变量/,
  );
  await assert.rejects(
    run(payload, { generate: generate("无关内容 {{目标用户}} {{产品}}") }),
    /未保留原始任务/,
  );
  await assert.rejects(
    run(
      { ...payload, prompt: "请写欢迎邮件" },
      { generate: generate("无关的菜谱") },
    ),
    /未保留原始任务/,
  );
});

test("optimization rejects bad structured output and invalid input before generation", async () => {
  await assert.rejects(
    run(payload, {
      generate: async () => ({
        data: { optimized: payload.prompt, changes: "wrong type" },
      }),
    }),
    ValidationError,
  );
  let calls = 0;
  const generate = async () => {
    calls++;
    return {};
  };
  for (const update of [
    { action: "delete" },
    { prompt: "" },
    { prompt: "x".repeat(16001) },
    { goal: "x".repeat(1001) },
    { tone: "unknown" },
  ]) {
    await assert.rejects(
      run({ ...payload, ...update }, { generate }),
      ValidationError,
    );
  }
  assert.equal(calls, 0);
});

test("test action sends the filled template and fixed execution input; preserves response envelope", async () => {
  let observed;
  const expected = {
    text: "真实结果",
    annotations: [{ type: "url_citation", url: "https://example.com" }],
    usage: { total_tokens: 3 },
  };
  const result = await run(
    {
      action: "test",
      prompt: "介绍{{产品}}给{{用户}}",
      variables: { 产品: "工具箱", 用户: "设计师" },
    },
    {
      generate: async (spec) => {
        observed = spec;
        return expected;
      },
    },
  );
  assert.equal(observed.instructions, "介绍工具箱给设计师");
  assert.equal(observed.input, "请执行以上任务。");
  assert.equal(result, expected);
});

test("test demo clearly labels its preview and shows the rendered task", async () => {
  const result = await run(
    { action: "test", prompt: "介绍{{产品}}", variables: { 产品: "工具箱" } },
    { generate: demoGenerate },
  );
  assert.match(result.text, /演示预览（未调用模型）/);
  assert.match(result.text, /介绍工具箱/);
  assert.deepEqual(result.annotations, []);
  assert.equal(result.usage, null);
});
