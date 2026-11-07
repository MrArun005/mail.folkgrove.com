FROM node:20-alpine
WORKDIR /app
COPY package.json lib.mjs server.mjs ./
USER node
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.mjs"]
