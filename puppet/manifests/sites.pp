node default {
    class{'chaos_system_packages':}
    class{'chaos_system_packages::setup_nginx':}
}
