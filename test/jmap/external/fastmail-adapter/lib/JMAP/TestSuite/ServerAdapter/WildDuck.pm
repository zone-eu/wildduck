package JMAP::TestSuite::ServerAdapter::WildDuck;

# WildDuck server adapter for fastmail/JMAP-TestSuite, written from the adapter contract described in
# test/jmap/external/README.md. Every account is a new WildDuck user created through the REST API, so
# any_account and pristine_account both return an empty account. The users of a test file are tagged
# jmap-testsuite and deleted when the file's process ends.
#
# Config (JMAP_SERVER_ADAPTER_FILE):
#   { "adapter": "WildDuck", "jmap_uri": "http://127.0.0.1:8091", "api_uri": "http://127.0.0.1:8080",
#     "api_token": "<optional REST API access token>", "domain": "example.com" }
#
# pool_account_pair is deliberately missing: WildDuck has no sharing, the cross account files skip.

use Moose;
with 'JMAP::TestSuite::ServerAdapter';

use HTTP::Request;
use JSON ();
use LWP::UserAgent;
use MIME::Base64 qw(encode_base64);

use JMAP::TestSuite::Account::WildDuck;

has jmap_uri  => (is => 'ro', isa => 'Str', required => 1);
has api_uri   => (is => 'ro', isa => 'Str', required => 1);
has api_token => (is => 'ro', isa => 'Maybe[Str]');
has domain    => (is => 'ro', isa => 'Str', default => 'example.com');

our $STARTTIME = time;
our $USERNUM   = 1;

my $OWNER_PID = $$;
my @CREATED;    # [ api_uri, api_token, user id, username ]

my $JSON = JSON->new->utf8->canonical;

sub _random_hex {
    my ($bytes) = @_;
    open my $fh, '<:raw', '/dev/urandom' or die "cannot read /dev/urandom: $!\n";
    read($fh, my $buf, $bytes) == $bytes or die "short read from /dev/urandom\n";
    close $fh;
    return unpack 'H*', $buf;
}

sub _rest {
    my ($api_uri, $api_token, $method, $path, $body) = @_;
    my $req = HTTP::Request->new($method => ($api_uri =~ s{/+\z}{}r) . $path);
    $req->header('Content-Type'   => 'application/json');
    $req->header('X-Access-Token' => $api_token) if defined $api_token && length $api_token;
    $req->content($JSON->encode($body)) if $body;
    my $res  = LWP::UserAgent->new(timeout => 30)->request($req);
    my $data = eval { $JSON->decode($res->decoded_content) } // {};
    die "$method $path: " . $res->status_line . ($data->{error} ? " ($data->{error})" : '') . "\n"
      unless $res->is_success && $data->{success};
    return $data;
}

# The session of a user, fetched with HTTP Basic (users are created with 2FA off)
sub fetch_session {
    my ($self, $username, $password) = @_;
    my $uri = ($self->jmap_uri =~ s{/+\z}{}r) . '/.well-known/jmap';
    my $ua  = LWP::UserAgent->new(timeout => 30);
    my $res = $ua->get($uri, Authorization => 'Basic ' . encode_base64("$username:$password", ''));
    die "GET $uri as $username: " . $res->status_line . "\n" unless $res->is_success;
    return ($uri, $JSON->decode($res->decoded_content));
}

sub _create_account {
    my ($self) = @_;

    # unique across parallel prove jobs and repeated runs
    my $name = "jt$STARTTIME$$" . 'n' . $USERNUM++;
    my $pass = _random_hex(16);

    my $created = _rest(
        $self->api_uri,
        $self->api_token,
        POST => '/users',
        {
            username    => $name,
            password    => $pass,
            address     => "$name\@" . $self->domain,
            name        => "JMAP-TestSuite $name",
            allowUnsafe => JSON::true,
            tags        => ['jmap-testsuite'],
        }
    );
    push @CREATED, [ $self->api_uri, $self->api_token, $created->{id}, $name ];

    # the JMAP account id is the one the session names, not necessarily the REST user id
    my (undef, $session) = $self->fetch_session($name, $pass);
    my $account_id = ($session->{primaryAccounts} // {})->{'urn:ietf:params:jmap:mail'}
      or die "no urn:ietf:params:jmap:mail primary account in the session of $name\n";

    return JMAP::TestSuite::Account::WildDuck->new({
        server    => $self,
        accountId => $account_id,
        username  => $name,
        password  => $pass,
    });
}

sub any_account      { $_[0]->_create_account }
sub pristine_account { $_[0]->_create_account }

END {
    # each .t file is its own process; only the process that created the users removes them
    if ($$ == $OWNER_PID) {
        for my $user (@CREATED) {
            my ($api_uri, $api_token, $id, $name) = @$user;
            eval { _rest($api_uri, $api_token, DELETE => "/users/$id"); 1 }
              or warn "could not delete test user $name ($id): $@";
        }
    }
}

no Moose;
__PACKAGE__->meta->make_immutable;
1;
