class chaos_system_packages {
	exec { "apt-get update" :
		command => "/usr/bin/apt-get update"
	}

	$packages = ['puppet']
	package {$packages : ensure => "latest", require => Exec['apt-get update']}

	exec { "apt-get upgrade" :
		command => "/usr/bin/apt-get upgrade -y",
	        require => Exec['apt-get update']
    	}
}
