import fnmatch

def part_name(source_parts, filename):
    """ return the part name of a file """
    for name, patterns in source_parts.items():
        for pattern in patterns:
            if fnmatch.fnmatch(filename, pattern):
                return name
    return None
