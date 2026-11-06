const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { VertexAI } = require('@google-cloud/vertexai');
const config = require('../config');

const GEMINI_MODEL_NAME = 'gemini-2.5-flash-lite';

let logger = null;
const getLogger = () => {
  if (!logger) {
    try {
      logger = require('../utils/logger').logger;
    } catch {
      logger = console;
    }
  }
  return logger;
};

class AiService {
  constructor() {
    this.model = null;
    this.isInitialized = false;
    this.provider = null;
    this.backend = null;

    const apiKey = (config.GEMINI_API_KEY || '').trim();

    if (apiKey) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        this.model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
        this.isInitialized = true;
        this.backend = 'studio';
        this.provider = 'Google AI Studio (API Key)';
        getLogger().info({
          provider: this.provider,
          model: GEMINI_MODEL_NAME,
        }, 'AI Service initialized')
      } catch (error) {
        getLogger().error({
          error: error.message,
          provider: 'Google AI Studio',
        }, 'Failed to initialize Gemini API Key')
      }
      return;
    }

    try {
      const projectId = config.GOOGLE_CLOUD_PROJECT_ID;
      const location = process.env.GOOGLE_CLOUD_REGION || 'us-central1';

      if (!projectId) {
        getLogger().warn('Both Vertex AI (missing GOOGLE_CLOUD_PROJECT_ID) and GEMINI_API_KEY are missing - AI Summarization disabled')
        return;
      }

      const vertexOptions = { project: projectId, location };
      const googleAuthOptions = this.resolveGoogleAuthOptions();
      if (googleAuthOptions) {
        vertexOptions.googleAuthOptions = googleAuthOptions;
      }

      const vertexAI = new VertexAI(vertexOptions);
      this.model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
      this.isInitialized = true;
      this.backend = 'vertex';
      this.provider = googleAuthOptions?.keyFilename
        ? `Google Cloud Vertex AI (credentials file)`
        : `Google Cloud Vertex AI (ADC)`;
      getLogger().info({
        provider: this.provider,
        projectId,
        model: GEMINI_MODEL_NAME,
        location,
      }, 'AI Service initialized via Vertex AI')
    } catch (error) {
      getLogger().warn({
        error: error.message,
        provider: 'Vertex AI',
      }, 'Failed to initialize Vertex AI - AI Summarization disabled')
    }
  }

  resolveGoogleAuthOptions() {
    const isProduction =
      process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production';

    if (isProduction) {
      return null;
    }

    const localCredentialsPath = path.join(
      __dirname,
      '..',
      '..',
      'google-credentials.json'
    );

    if (fs.existsSync(localCredentialsPath)) {
      return { keyFilename: localCredentialsPath };
    }

    return null;
  }

  extractText(result) {
    const response = result?.response;
    if (!response) {
      return '';
    }

    if (typeof response.text === 'function') {
      try {
        return response.text() || '';
      } catch {
        // Vertex sometimes throws if candidates are empty / blocked
      }
    }

    const parts = response.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      return parts.map((part) => part.text || '').join('').trim();
    }

    return '';
  }

  async generateSummary(text) {
    if (!this.isInitialized || !text || text.trim().length === 0) {
      if (!this.isInitialized) {
        getLogger().debug('AI Summary skipped - AI service is not initialized')
      }
      return null;
    }

    const startTime = Date.now()
    try {
      const prompt = `Please provide a concise, high-level summary of the following session transcription. Keep it to 2-3 paragraphs maximum.

      CRITICAL INSTRUCTIONS:
      - First, identify the type of content (e.g., sermon, Bible study, lecture, meeting, workshop, speech) and tailor the summary to match its context.
      - If the content is religious in nature, ground the summary in relevant Scripture references mentioned in the transcription. 📖
      - Focus on the main themes and key takeaways.
      - Always provide a summary or your best attempt at extracting the meaning, even if the text is extremely short or a single sentence.
      - DO NOT state that a summary cannot be provided.
      - DO NOT include any conversational filler, meta-commentary, or explanations. Just output the summary.

      Transcription:\n${text}`;

      const result = await this.model.generateContent(prompt);
      const summary = this.extractText(result);

      if (!summary) {
        getLogger().warn({
          textLength: text.length,
          duration: Date.now() - startTime,
        }, 'AI Summary returned empty content')
        return null;
      }

      getLogger().info({
        textLength: text.length,
        summaryLength: summary.length,
        duration: Date.now() - startTime,
      }, 'AI Summary generated successfully')

      return summary;
    } catch (error) {
      getLogger().error({
        error: error.message,
        stack: error.stack,
        textLength: text.length,
        duration: Date.now() - startTime,
      }, 'AI Summary generation failed')
      throw error;
    }
  }
}

module.exports = new AiService();
