from encryption import decrypt


def GetKeys(twitter_keys_path):
    consumer_key = ''
    consumer_secret = ''
    access_token = ''
    access_secret = ''
    PATH = 'twitter_keys.secret/'
    l_files = ['consumer_key', 'consumer_secret', 'access_token', 'access_secret']

    for k in l_files:
        f = open(PATH + k + ".secret", 'rb')
        key = f.read()
        if (k == 'consumer_key'):
            consumer_key = decrypt(key)
            # consumer_key = 'N5JrjZDqCtQ346nXF80BV20v9'
        if (k == 'consumer_secret'):
            consumer_secret = decrypt(key)
            # consumer_secret = 'enEPaLQXPjYERBhPOxrWws4l6uFjC0YD7klwRRITR09z6bHmI2'
        if (k == 'access_token'):
            access_token = decrypt(key)
            # access_token = '732737955962486786-V84lxJ35cep5hNOPaQ6WYBs40AvRTX4'
        if (k == 'access_secret'):
            access_secret = decrypt(key)
            # access_secret = 'PKNttIB5rExAFgaqaFZP1OOl7yppsExltzNkNmTZmnPQ4'
        f.close()
    """
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

    """
    return {'consumer_key': consumer_key, 'consumer_secret': consumer_secret,
            'access_token': access_token, 'access_secret': access_secret}
