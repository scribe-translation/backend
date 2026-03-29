require('dotenv').config();
const { initFirestore } = require('./src/database/firestore');
const Sermon = require('./src/models/Sermon');
const User = require('./src/models/User');
const aiService = require('./src/services/aiService');

async function testSermonFlow() {
  try {
    console.log('1. Initializing Firestore...');
    await initFirestore();

    console.log('2. Creating a test user...');
    // Create a mock user or use an existing one
    const testEmail = `test-${Date.now()}@example.com`;
    const user = await User.create('Test Pastor', testEmail, 'password123');
    console.log(`✅ User created with ID: ${user.id}`);

    const sampleTranscript = "Welcome everyone to our service today. We are going to talk about community and love. It is so important to care for one another, especially in difficult times. Love is patient, love is kind. Let us strive to embody these principles every single day.";

    console.log('3. Simulating background processing (saving to DB)...');
    
    // Simulate what handleBackgroundProcessing does
    const sermon = await Sermon.create({
      userId: user.id,
      fullText: sampleTranscript,
      sourceLanguage: 'en-US'
    });
    console.log(`✅ Sermon saved successfully with ID: ${sermon.id}`);

    console.log('4. Simulating AI generation...');
    // The API key is likely not set for Gemini in this environment unless the user set it up,
    // so we'll just test that the wrapper handles errors gracefully if uninitialized
    let summary = null;
    let facebookPost = null;
    if (aiService.isInitialized) {
      console.log('   Generating Summary...');
      summary = await aiService.generateSummary(sampleTranscript);
      console.log(`   Result: ${summary?.substring(0, 50)}...`);

      console.log('   Generating Facebook Post...');
      facebookPost = await aiService.generateFacebookPost(sampleTranscript);
      console.log(`   Result: ${facebookPost?.substring(0, 50)}...`);
    } else {
      console.log('   Skipping AI generation (GEMINI_API_KEY not set).');
    }

    console.log('5. Updating Sermon with AI results...');
    const updatedSermon = await Sermon.update(sermon.id, {
      summary: summary || null,
      facebookPost: facebookPost || null
    });

    console.log('✅ Final Sermon object:', {
      id: updatedSermon.id,
      fullTextPreview: updatedSermon.fullText.substring(0, 30) + '...',
      hasSummary: !!updatedSermon.summary,
      hasFacebookPost: !!updatedSermon.facebookPost
    });

    console.log('\n🎉 Test completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testSermonFlow();
