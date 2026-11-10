FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip fonts-liberation fonts-dejavu-core && pip3 install --break-system-packages -U "yt-dlp[default,curl-cffi]" && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node","server.js"]
