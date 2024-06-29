FROM oven/bun:1
WORKDIR /app/
COPY dist/bundler.js /app/
COPY bundler.sh /app/
RUN chmod +rx /app/bundler.sh
ENTRYPOINT [ "/app/bundler.sh" ]
