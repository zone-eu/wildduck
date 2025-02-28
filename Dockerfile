FROM --platform=${BUILDPLATFORM} node:lts-alpine
ARG TARGETPLATFORM
ARG TARGETARCH
ARG TARGETVARIANT
RUN printf "I'm building for TARGETPLATFORM=${TARGETPLATFORM}" \
    && printf ", TARGETARCH=${TARGETARCH}" \
    && printf ", TARGETVARIANT=${TARGETVARIANT} \n" \
    && printf "With uname -s : " && uname -s \
    && printf "and  uname -m : " && uname -mm

RUN apk --no-cache add make git dumb-init openssl

WORKDIR /wildduck

COPY package*.json ./
RUN npm install --production

COPY . .

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "/wildduck/server.js", "--config=/wildduck/config/default.toml"]
