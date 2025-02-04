# syntax=docker/dockerfile:1
FROM debian:bookworm-20221004-slim as BUILD

RUN apt-get update && apt-get install  -y --no-install-recommends  \
    nodejs \
    npm \
    cmake \
    build-essential \
    ninja-build \
    pkg-config \
    libffi-dev \
    libudev-dev \
    libgbm-dev \
    libdrm-dev \
    libegl-dev \
    libopengl-dev \
    libglib2.0-dev \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-bad1.0-dev \
    libgraphene-1.0-dev \
    git \
    python3 \
    python3-distutils \
    curl \
    ca-certificates \
    flex \
    bison \
    liborc-0.4-dev-bin \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# build gstreamer from source
RUN curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py \
    && python3 get-pip.py \
    && python3 -m pip install meson \
    && git clone --depth 1 --branch 1.20 https://gitlab.freedesktop.org/gstreamer/gstreamer.git

RUN  cd /gstreamer \
     && meson build \
      --buildtype=release \
      --strip \
      -Dgpl=enabled \
      -Dorc=enabled \
      -Dbase=enabled \
      -Dgood=enabled \
      -Dbad=enabled \
      -Dugly=enabled \
      -Dauto_features=disabled \
      -Dgst-plugins-base:app=enabled \
      -Dgst-plugins-base:gl=enabled \
      -Dgst-plugins-base:gl-graphene=enabled \
      -Dgst-plugins-base:gl_winsys=egl \
      -Dgst-plugins-base:gl_api=opengl \
      -Dgst-plugins-bad:gl=enabled \
      -Dgst-plugins-bad:nvcodec=enabled \
    && ninja -C build

WORKDIR /app
RUN npm install --global yarn
COPY ["package.json", "yarn.lock", "./"]
RUN yarn install

COPY . .
RUN yarn generate
RUN yarn build

FROM debian:bookworm-20221004-slim
RUN sed -r -i 's/^deb(.*)$/deb\1 contrib/g' /etc/apt/sources.list
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    libffi8 \
    libudev1 \
    libgbm1 \
    libgraphene-1.0-0 \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-gl \
    libosmesa6 \
    libdrm2 \
    libdrm-intel1 \
    libopengl0 \
    libglvnd0 \
    libglx0 \
    libglapi-mesa \
    libegl1-mesa \
    libglx-mesa0 \
    libnvidia-egl-wayland1 \
    libnvidia-egl-gbm1 \
    xwayland \
    xauth \
    xxd \
    inotify-tools \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=BUILD /gstreamer/build/subprojects/gst-plugins-bad/sys/nvcodec/libgstnvcodec.so /usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstnvcodec.so

COPY 10_nvidia.json /usr/share/glvnd/egl_vendor.d/10_nvidia.json

WORKDIR /app
COPY --from=BUILD /app/package.json .
COPY --from=BUILD /app/yarn.lock .
COPY --from=BUILD /app/dist /app/dist
COPY --from=BUILD /app/docker-entrypoint.sh .
RUN npm install --global yarn
RUN yarn install --production --ignore-optional
COPY --from=BUILD /app/node_modules/westfield-proxy /app/node_modules/westfield-proxy
COPY --from=BUILD /app/node_modules/epoll /app/node_modules/epoll
COPY --from=BUILD /app/node_modules/bindings /app/node_modules/bindings
COPY --from=BUILD /app/node_modules/file-uri-to-path /app/node_modules/file-uri-to-path
RUN chown -R 1000:1000 /app

RUN mkdir -p /var/run/compositor-proxy && chown 1000:1000 /var/run/compositor-proxy && touch /var/run/compositor-proxy/starting
COPY wait-until-ready.sh /app

RUN groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --shell /bin/bash --create-home node
WORKDIR /home/node
CMD ["sh", "/app/docker-entrypoint.sh"]
