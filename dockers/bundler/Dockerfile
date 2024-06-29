FROM oven/bun:1
WORKDIR /app/
COPY dist/bundler.js /app/
ENTRYPOINT [ "bun", "run", "/app/dist/bundler.js" ]
