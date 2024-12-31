FROM oven/bun:1.1
WORKDIR /app/

RUN apt-get update && \
    apt-get install -y procps curl vim less && \
    apt-get clean

COPY dist/bundler.js /app/
ENTRYPOINT [ "bun", "run", "/app/bundler.js" ]
