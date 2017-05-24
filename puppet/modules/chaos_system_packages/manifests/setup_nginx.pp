class chaos_system_packages::setup_nginx {
	class {'nginx': }
	
	nginx::resource::server { 'chaosthebot.com' :
		listen_port => 80,
		proxy => 'http://localhost:8080'
	}
}
