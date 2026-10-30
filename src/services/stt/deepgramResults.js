function parseDeepgramResultsMessage(message) {
  if (!message || message.type !== 'Results') {
    return [];
  }

  const alternative = message.channel?.alternatives?.[0];
  const transcript = alternative?.transcript;
  if (!transcript || !String(transcript).trim()) {
    return [];
  }

  return [{
    transcript: String(transcript),
    isFinal: message.is_final === true,
    confidence: typeof alternative.confidence === 'number' ? alternative.confidence : 0.8,
    resultEndTime: message.duration,
  }];
}

module.exports = {
  parseDeepgramResultsMessage,
};
