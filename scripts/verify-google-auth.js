#!/usr/bin/env node
/* Quick verification script for Google ADC (Vertex + Vision)
   Usage: node scripts/verify-google-auth.js
*/
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { VertexAI } = require('@google-cloud/vertexai');

(async () => {
  try {
    // VertexAI client instantiate + a lightweight generateContent attempt (may error if API disabled)
    try {
      const vertex = new VertexAI();
      console.log('Vertex client created');
      try {
        const model = vertex.getGenerativeModel({ model: process.env.VERTEX_TEST_MODEL || 'text-bison@001' });
        await model.generateContent({ contents: [{ text: 'say ok' }] });
        console.log('Vertex test call succeeded');
      } catch (e) {
        console.error('Vertex test call failed:', e.message || e.toString());
      }
    } catch (err) {
      console.error('Vertex client initialization failed:', err.message || err.toString());
    }

    // Vision API test: documentTextDetection on a 1x1 PNG
    try {
      const vision = new ImageAnnotatorClient();
      console.log('Vision client created');
      const img = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAn8B9n8tKgAAAABJRU5ErkJggg==', 'base64');
      const [res] = await vision.documentTextDetection({ image: { content: img } });
      console.log('Vision test call finished. Text length:', (res.fullTextAnnotation && res.fullTextAnnotation.text) ? res.fullTextAnnotation.text.length : 0);
    } catch (err) {
      console.error('Vision test call failed:', err.message || err.toString());
    }

    process.exit(0);
  } catch (e) {
    console.error('Verification script failed:', e.message || e.toString());
    process.exit(1);
  }
})();
