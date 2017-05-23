import os

#set the process name to "chaos_server" so we can easily kill it with "pkill chaos_server"
def set_proc_name(newname):
    from ctypes import cdll, byref, create_string_buffer
    libc = cdll.LoadLibrary('libc.so.6')
    buff = create_string_buffer(len(newname)+1)
    buff.value = newname.encode("ascii")
    libc.prctl(15, byref(buff), 0, 0, 0)
set_proc_name("chaos_irc_server")

if not os.path.exists('miniircd'):
    # install irc daemon
    os.system('git clone https://github.com/jrosdahl/miniircd.git')
    
os.system('./miniircd/miniircd --state-dir=/ --log-file=/ircd.log --motd=/motd.txt --setuid=nobody --chroot=./server/ircjail')
