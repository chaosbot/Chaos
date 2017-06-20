import json
import base64
try:
    from encryption import decrypt, encrypt
except:
    # We may need to encrypt when not in a server environment
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    def encrypt(plaintext):
        with open("server/pubkey.txt", "rb") as key_file:
            public_key = load_pem_public_key(key_file.read(), default_backend())
        return public_key.encrypt(plaintext,
                                  padding.OAEP(
                                      padding.MGF1(hashes.SHA1()),
                                      hashes.SHA1(),
                                      None
                                      ))

    def decrypt(ciphertext):
        raise NotImplementedError("This only works in a running server env")


# It's a context manager y'all
class KeyManager():

    def __init__(self, keys_file_name="symmetric_keys.json"):
        self.keys_file_name = keys_file_name
        self.existing_keys = {}

        # Try to load existing keys
        try:
            with open(keys_file_name) as keys_file:
                self.existing_keys = json.load(keys_file)
        except FileNotFoundError:
            # Welp, aren't any
            pass

    def __enter__(self):
        return self

    def get_key(self, key_name):
        # base64 decode the string object in the dict and decrypt and return
        # base64.b64decode() returns bytes for us
        return decrypt(base64.b64decode(self.existing_keys[key_name]))

    def add_key(self, key_name, key):
        # encrypt the base64 encoded ASCII bytes then b64encode that
        # and decode it to a Unicode string (JSON doesn't work with bytes)
        # and store it
        self.existing_keys[key_name] = base64.b64encode(
            encrypt(key)).decode('ascii')

    def __exit__(self, exc_type, exc_value, traceback):
        # Save the keys when we are finished
        with open(self.keys_file_name, 'w') as keys_file:
            json.dump(self.existing_keys, keys_file)
