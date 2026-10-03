FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node . .
ENV HOST=0.0.0.0 PORT=3102
USER node
EXPOSE 3102
CMD ["node", "--env-file-if-exists=.env", "server.mjs"]
