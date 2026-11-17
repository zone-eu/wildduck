package JMAP::TestSuite::Account::WildDuck;

# A WildDuck user as seen by fastmail/JMAP-TestSuite, see ServerAdapter/WildDuck.pm.

use Moose;
with 'JMAP::TestSuite::Account';

use MIME::Base64 qw(encode_base64);
use JMAP::TestSuite::JMAP::Tester::WithSugar;

has username => (is => 'ro', isa => 'Str', required => 1);
has password => (is => 'ro', isa => 'Str', required => 1);

sub authenticated_tester {
    my ($self) = @_;

    my ($session_uri, $session) = $self->server->fetch_session($self->username, $self->password);

    # several files fetch the session themselves and use its URLs, so the server's jmap.baseUrl must be
    # the origin the suite reaches it under; scripts/jmap/run-fastmail.js checks that before the run
    for my $key (qw(apiUrl uploadUrl downloadUrl)) {
        die "session of " . $self->username . " has no $key\n" unless $session->{$key};
    }

    my $account_id = $self->accountId;
    my $upload_uri = $session->{uploadUrl};
    $upload_uri =~ s/\{accountId\}/$account_id/g;

    my $tester = JMAP::TestSuite::JMAP::Tester::WithSugar->new({
        authentication_uri => $session_uri,
        api_uri            => $session->{apiUrl},
        upload_uri         => $upload_uri,
        # keeps the {accountId} {blobId} {name} {type} variables, the tester fills them in
        download_uri       => $session->{downloadUrl},
    });

    $tester->ua->set_default_header(
        Authorization => 'Basic ' . encode_base64($self->username . ':' . $self->password, '')
    );

    # only what the server advertises, so require_capabilities skips what WildDuck does not support yet
    $tester->default_using([ sort keys %{ $session->{capabilities} // {} } ]);

    return $tester;
}

no Moose;
__PACKAGE__->meta->make_immutable;
1;
