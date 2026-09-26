# ghcr.io/yea-protocol/yea: the parley CLI with zero Node setup on your side.
#   docker run --rm ghcr.io/yea-protocol/yea demo
#   docker run --rm -p 7447:7447 ghcr.io/yea-protocol/yea openapi https://petstore3.swagger.io/api/v3/openapi.json --base https://petstore3.swagger.io/api/v3 --host 0.0.0.0
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY ts/package.json ts/
RUN npm ci --workspace parley-protocol --include-workspace-root=false --ignore-scripts
COPY ts ts
RUN npm run build -w parley-protocol && cd ts && npm pack --silent && mv parley-protocol-*.tgz /parley.tgz

FROM node:22-alpine
COPY --from=build /parley.tgz /parley.tgz
RUN npm install -g /parley.tgz && rm /parley.tgz && adduser -D parley
USER parley
EXPOSE 7447 8080
ENTRYPOINT ["parley"]
CMD ["--help"]
