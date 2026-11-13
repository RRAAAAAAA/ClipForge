FROM node:20-slim
RUN apt-get update && apt-get install -y curl ffmpeg python3 python3-pip && pip3 install --break-system-packages -U "yt-dlp[default,curl-cffi]" "opencv-python-headless>=4.9,<5" numpy && rm -rf /var/lib/apt/lists/*
RUN npm install -g deno
WORKDIR /app
RUN curl -fsSL -o yunet.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx && [ "$(stat -c%s yunet.onnx)" -gt 100000 ] || rm -f yunet.onnx
COPY package.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node","server.js"]
