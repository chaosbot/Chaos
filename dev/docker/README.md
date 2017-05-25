# Docker

These instructions will get you a runnable docker image where you can test the
complete chaos environment **on your own chaos fork.**

## Setup

### Personal Access Token

First you'll need to set up a Personal Access Token (PAT).  Go to your [Github
Personal Access Token](https://github.com/settings/tokens) settings. PATs are
like passwords, only more secure, because you can enable limited actions for
them, and they're easy to revoke if they are compromised.  Click "Generate new
token" at the top right.  For your Token description, enter "chaos test".  Then
you'll need to check the following options:

* repo
  * public\_repo ✓
* user
  * user:follow ✓

When you're done with that, click the green "Generate Token" at the bottom.  And
copy the token it displays on the screen.  **Be sure to copy it now, since you
won't see it again.**  If you lose it, you'll have to regenerate another one.

Put your PAT in the file `github_pat.secret` in the root of the chaos repo so
you don't lose it.  Be sure not to commit this file and share it with the world
:)

### Building the docker image

To build the docker image, navigate to `dev/docker/` and run `bash build.sh`.
This will run the Dockerfile and produce your docker image with the name
`chaos`.

## Running

Make sure you're in `dev/docker/` and run `bash run.sh`. 

## Development Cycle

The repo dir exists as a mounted [data
volume](https://docs.docker.com/engine/tutorials/dockervolumes/#data-volumes)
inside the your running docker container.  What this means is that files created
or edited inside the container, in `/root/workspace/chaos` -- will exist
outside the container, and vice versa.

1. Edit your files locally and make your changes.
2. Run `bash run.sh`.
3. Watch chaos startup in your terminal, tailing its error and stdout logs.
4. Make some dummy pull requests or whatever **on your github fork.**
5. Watch chaos interact with your github fork, as if it was the main
   `chaosbot/chaos` repo.
6. Open a PR to `chaosbot/chaos` once you're convinced your changes work.

## Monitoring

The environment inside the docker image should be very very close to what's
actually on production.  As such, any servers started by chaos inside the
container may be accessed from your host machine.  At the time of this writing,
there are currently two servers running:

### container port => host port
* 80 => 8082 - python server/server.py webserver
* 8081 => 8081 - nginx static directory to `/var/log/supervisor`
