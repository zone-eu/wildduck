# Wildduck docker image

## Obtaining the Docker image
To pull the latest pre-built image of wildduck from docker hub:

```
docker pull nodemailer/wildduck
```

It is also possible to pull a specific version of wildduck by specifying the version as the image tag.
(example, for version 1.20):
```
docker pull nodemailer/wildduck:1.20
```
## Environment variables in the Docker image
The following docker env variables are available inside the container:
1. `WILDDUCK_APPDIR`: The folder where wildduck is installed inside the container
2. `WILDDUCK_CONFIG`: Path to the config file to be used with wildduck
3. `CMD_ARGS`: Any additional cmd options to pass to wildduck running inside the docker container


## Running wildduck using Docker
The image is configured to use the [default config file](https://github.com/nodemailer/wildduck/blob/master/config/default.toml)
```
docker run nodemailer/wildduck
```
This is likely to fail due to `mongodb` and `redis` not present in `localhost` inside the container. To pass custom configuration options/files to  wildduck inside the docker image, the following two strategies can be used:
1. Pass `CMD_ARGS` to configure options using [wild-config](https://github.com/nodemailer/wild-config)
    
    To set a custom `mongo` and `redis` host, and configure the `FQDN` and the domain for receiving emails:
    ```bash
    FQDN='example.com'
    MAIL_DOMAIN='mail.example.com'
    docker run \ 
    -e APPCONF_dbs_mongo='mongodb://mongo:27017/' \
    -e APPCONF_dbs_redis='redis://redis:6379/3' \
    -e APPCONF_smtp_setup_hostname=$FQDN \
    -e APPCONF_log_gelf_hostname=$FQDN \
    -e APPCONF_imap_setup_hostname=$FQDN \
    -e APPCONF_emailDomain=$MAIL_DOMAIN \
    nodemailer/wildduck
    ```

    More details available at the [wild-config](https://github.com/nodemailer/wild-config) documentation.
2. Mount a Docker volume with a custom configuration file:
    
    To replace the default config folder (`/wildduck/config`) inside the docker image
    ```bash
    docker run -v '/config/from/host:/wildduck/config' nodemailer/wildduck
    ```