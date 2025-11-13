import { VertexAI } from '@google-cloud/vertexai';
import { ImageAnnotatorClient } from '@google-cloud/vision';

const GOOGLE_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'cbt-vision-api';
const GOOGLE_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

let vertexInstance: VertexAI | null = null;
let visionInstance: ImageAnnotatorClient | null = null;

export function getVertexClient(): VertexAI {
  if (!vertexInstance) {
    vertexInstance = new VertexAI({ project: GOOGLE_PROJECT, location: GOOGLE_LOCATION });
    console.log(`VertexAI initialized: project=${GOOGLE_PROJECT}, location=${GOOGLE_LOCATION}`);
  }
  return vertexInstance;
}

export function getVisionClient(): ImageAnnotatorClient {
  if (!visionInstance) {
    visionInstance = new ImageAnnotatorClient();
    console.log('ImageAnnotatorClient initialized');
  }
  return visionInstance;
}
