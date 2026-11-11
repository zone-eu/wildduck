# Perl runtime for fastmail/JMAP-TestSuite, used by scripts/jmap/run-fastmail.js.
#
# The suite has no licence, so it is never copied into this repository or into the image. The build
# context is the suite clone at the pinned commit, and only its cpanfile is read to install the
# dependencies. The suite itself, the WildDuck adapter (this directory) and the adapter config are
# mounted when the container runs:
#
#   docker build -f test/jmap/external/fastmail-adapter/Dockerfile -t wildduck-jmap-fastmail:<commit> <suite clone>
#   docker run --rm -v <suite clone>:/suite:ro -v <this directory>/lib:/adapter:ro -v <config dir>:/config:ro \
#       -e JMAP_SERVER_ADAPTER_FILE=/config/adapter.json wildduck-jmap-fastmail:<commit> prove -Ilib -I/adapter -v -r t
FROM perl:5.40

# --notest: the dependency test suites would take most of the build time and test nothing of ours
COPY cpanfile /tmp/suite-deps/cpanfile
RUN cpanm --quiet --notest --installdeps /tmp/suite-deps && rm -rf /tmp/suite-deps /root/.cpanm

WORKDIR /suite
