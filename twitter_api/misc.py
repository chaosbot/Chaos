from encryption import decrypt


def GetKeys(twitter_keys_path):
    consumer_key = ''
    consumer_secret = ''
    access_token = ''
    access_secret = ''
    fo = open(twitter_keys_path, 'rb')
    keys = fo.readlines()

    for k in keys:
        try:
            values = k.split('\n')[0].split('=')[1].strip()
            if(k.split('\n')[0].split('=')[0].strip() == 'consumer_key'):
                consumer_key = decrypt(values)
            elif(k.split('\n')[0].split('=')[0].strip() == 'consumer_secret'):
                consumer_secret = decrypt(values)
            elif(k.split('\n')[0].split('=')[0].strip() == 'access_token'):
                access_token = decrypt(values)
            elif(k.split('\n')[0].split('=')[0].strip() == 'access_secret'):
                access_secret = decrypt(values)
        except IndexError:
            # Maybe there are a '\n' between keys
            continue
    return {'consumer_key': consumer_key, 'consumer_secret': consumer_secret,
            'access_token': access_token, 'access_secret': access_secret}
