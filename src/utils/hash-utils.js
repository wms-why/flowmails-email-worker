const encoder = new TextEncoder();

const hashUtils = {
  async sha256Hex(text) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(text));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((item) => item.toString(16).padStart(2, '0')).join('');
  },
};

export default hashUtils;
