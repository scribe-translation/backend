const { GoogleGenerativeAI } = require('@google/generative-ai');
const { VertexAI } = require('@google-cloud/vertexai');
const config = require('../config');

const GEMINI_MODEL_NAME = 'gemini-2.5-flash-lite';

class AiService {
  constructor() {
    this.model = null;
    this.isInitialized = false;
    this.provider = null;

    // We check for an explicit API key first (development/fallback)
    const apiKey = config.GEMINI_API_KEY;

    if (apiKey) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        this.model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
        this.isInitialized = true;
        this.provider = 'Google AI Studio (API Key)';
        console.log(`✅ AI Service initialized via: ${this.provider}`);
      } catch (error) {
        console.error('❌ Failed to initialize Gemini API Key:', error.message);
      }
    } else {
      // If no API key, use Google Cloud ADC via Vertex AI (Production format)
      try {
        const projectId = config.GOOGLE_CLOUD_PROJECT_ID;
        // Vertex AI requires a region. 'us-central1' is the standard default for Gemini.
        const location = process.env.GOOGLE_CLOUD_REGION || 'us-central1';

        if (projectId) {
          const vertexAI = new VertexAI({ project: projectId, location: location });

          // Use the recommended fast/cheap model for text tasks
          this.model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
          this.isInitialized = true;
          this.provider = 'Google Cloud Vertex AI (ADC)';
          console.log(`✅ AI Service initialized via: ${this.provider} for project ${projectId}`);
        } else {
          console.warn('⚠️ Both Vertex AI (missing GOOGLE_CLOUD_PROJECT_ID) and GEMINI_API_KEY are missing. AI Summarization disabled.');
        }
      } catch (error) {
        console.warn('⚠️ Failed to initialize Vertex AI. AI Summarization disabled.', error.message);
      }
    }
  }

  async generateSummary(text) {
    if (!this.isInitialized || !text || text.trim().length === 0) {
      return null;
    }

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
      const response = await result.response;

      // Handle slight difference in SDK response formats just in case
      if (response.text && typeof response.text === 'function') {
        return response.text();
      }
      return response.candidates?.[0]?.content?.parts?.[0]?.text || '';

    } catch (error) {
      console.error('❌ AI Summary generation failed:', error.message);
      throw error;
    }
  }

  async generateFacebookPost(text) {
    if (!this.isInitialized || !text || text.trim().length === 0) {
      return null;
    }

    try {
      const prompt = `You are a social media manager for an organization. Write exactly ONE engaging, comprehensive, and inspiring Facebook post based on the following session transcription.

      First, identify the type of content (e.g., sermon, Bible study, lecture, meeting, workshop, speech) and tailor the post to match its context and tone.

      The post structure should include:
      - An attention-grabbing hook or inspiring thought at the very beginning. ✨
      - A section called "Key Takeaways" or similar, using bullet points (e.g., • or -) to make the message easy to read on mobile. 📱
      - If the content is religious in nature, include or reference key Scripture mentioned in the transcription. 📖
      - Generous use of relevant emojis throughout to break up text and add personality.
      - A strong Call to Action (CTA) at the end: Ask a thoughtful question, encourage people to share the post, or invite them to reflect. 💬

      CRITICAL INSTRUCTIONS:
      - ALWAYS provide exactly ONE post option. Do NOT provide alternatives.
      - DO NOT include any instructions, placeholders (like "[Link here]"), meta-commentary, notes, or tips.
      - DO NOT explain your choices. Output ONLY the raw text for the Facebook post itself, ready to be copied and pasted.
      - Ensure the tone is warm, inviting, and grounded in the provided transcription.

      Transcription:\n${text}`;

      const result = await this.model.generateContent(prompt);
      const response = await result.response;

      if (response.text && typeof response.text === 'function') {
        return response.text();
      }
      return response.candidates?.[0]?.content?.parts?.[0]?.text || '';

    } catch (error) {
      console.error('❌ AI Facebook Post generation failed:', error.message);
      throw error;
    }
  }
}

module.exports = new AiService();
