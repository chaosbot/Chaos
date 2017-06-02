import sys
from cryptography.fernet import Fernet
from symmetric_keys import KeyManager

# You gotta tell us what to call this key
try:
    key_name = sys.argv[1]
    file_to_encrypt = sys.argv[2]
except KeyError:
    print("Usage:", sys.argv[0], "keyname file_to_encrypt")
    sys.exit(1)

# Make the symmetric key
key = Fernet.generate_key()

with KeyManager() as key_manager:
    key_manager.add_key(key_name, key)

with open(file_to_encrypt, 'r+b') as config_file:
    contents = config_file.read()
    config_file.seek(0)
    config_file.write(Fernet(key).encrypt(contents))
    config_file.flush()
