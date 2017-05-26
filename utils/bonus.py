def is_palindrome(val):
    return str(val) == str(val)[::-1]

def is_1337(val):
    return (val % 1337) == 0
