// Model metadata only. Pixel/result contracts live in shared/portrait.ts.
export const PORTRAIT_MODELS = {
  body: {
    id: 'schp-atr18-int8', filename: 'portrait-schp-atr18-int8.onnx', sourceName: 'schp.onnx',
    bytes: 69141996, sha256: '4420d8db8c1f266967c89485786b01209f6d405f320fc0f87e8ced49392cefb5',
    url: 'https://huggingface.co/pirocheto/schp-atr-18/resolve/61f4ff3c508b899904e495cefbbaff9cacadeb45/onnx/schp-atr-18-int8-static.onnx',
    source: 'https://github.com/GoGoDuck912/Self-Correction-Human-Parsing',
    conversion: 'https://huggingface.co/pirocheto/schp-atr-18', license: 'MIT', licenseFile: 'portrait-schp.txt'
  },
  face: {
    id: 'bisenet-resnet18', filename: 'portrait-bisenet-resnet18.onnx', sourceName: 'bisenet.onnx',
    bytes: 53205364, sha256: '0d9bd318e46987c3bdbfacae9e2c0f461cae1c6ac6ea6d43bbe541a91727e33f',
    url: 'https://github.com/yakhyo/face-parsing/releases/download/weights/resnet18.onnx',
    source: 'https://github.com/yakhyo/face-parsing', license: 'MIT', licenseFile: 'portrait-bisenet.txt'
  },
  detector: {
    id: 'yunet-2023mar', filename: 'portrait-yunet.onnx', sourceName: 'yunet.onnx',
    bytes: 232589, sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet', license: 'MIT', licenseFile: 'portrait-yunet.txt'
  }
} as const
export type PortraitModelKey = keyof typeof PORTRAIT_MODELS
export type PortraitModelPaths = Record<PortraitModelKey, string>
export const PORTRAIT_MODEL_FINGERPRINT = `portrait-cnn-v1:${PORTRAIT_MODELS.body.sha256}:${PORTRAIT_MODELS.face.sha256}:${PORTRAIT_MODELS.detector.sha256}`
export const PORTRAIT_SESSION_OPTIONS = {
  executionProviders: ['cpu'], graphOptimizationLevel: 'all',
  intraOpNumThreads: 4, interOpNumThreads: 1, executionMode: 'sequential',
  enableCpuMemArena: false, enableMemPattern: false, logSeverityLevel: 3
} as const
