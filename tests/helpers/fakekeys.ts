// Key-shaped fakes for the tests of the secret scanner, built at runtime: no arnx file holds a key-shaped literal, so
// setup run on arnx itself withholds none of its tests.
export const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
export const AWS_KEY_2 = "AKIA" + "ABCDEFGHIJKLMNOP";
export const PRIVATE_KEY = "-----BEGIN RSA " + "PRIVATE KEY-----";
export const SLACK_TOKEN = "xoxb" + "-1234567890-abc";
/** A private key with a body: no stand-in keeps it out, so a snapshot leaves its file out. */
export const PRIVATE_KEY_BLOCK = `${PRIVATE_KEY}\nMIIEowIBAAKCAQEAx7Kq9Lw2Zp4Ru8Yb3Nc6Df1Gh5Jk0Mn2Qs7Tv9Wx\n` +
  "-----END RSA " + "PRIVATE KEY-----";
