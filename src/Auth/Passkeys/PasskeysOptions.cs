// Passkeys:ServerDomain (docs/ARCHITECTURE.md, "Backend", configuration): the portal's host name, the RP ID of every
// passkey. Checked at start in every environment (AuthModule), so the RP ID never comes from a request's Host.
namespace Claushh.Api.Auth.Passkeys;

public sealed class PasskeysOptions
{
    // A lower-case DNS name without scheme or port: localhost in development and the tests, <domain> on the server.
    public string ServerDomain { get; set; } = "";
}
