from encryption import decrypt


def GetKeys(twitter_keys_path):
    consumer_key = ''
    consumer_secret = ''
    access_token = ''
    access_secret = ''
    # PATH = 'twitter_keys.secret/'
    l_files = ['consumer_key', 'consumer_secret', 'access_token', 'access_secret']

    for k in l_files:
        # f = open(PATH + k + ".secret", 'rb')
        # key = f.read()
        if (k == 'consumer_key'):
            consumer_key = '0Vj9kAlcViVv2QL4d6UqNWaVo'
        if (k == 'consumer_secret'):
            consumer_secret = '9CVW0rJZGaGH19EfV9XT1skRwp7pj24iucmojuDIGMePi0Nny3'
        if (k == 'access_token'):
            access_token = '873520342207221760-wjSr5HdjoeYaZzVLyQs9OvDrIaXD5JA'
        if (k == 'access_secret'):
            access_secret = 'CN8IGEoOUVvvPCLE5uIuWQWC902cNIqbtCAgI5DWbD6IK'
        # f.close()
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
