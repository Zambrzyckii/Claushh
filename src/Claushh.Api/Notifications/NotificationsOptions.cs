// Notifications:NtfyUrl and Notifications:NtfyToken (docs/ARCHITECTURE.md, "Backend", configuration): where the phone
// notifications of logins go. The URL is a secret (whoever knows the topic can read it), so it is never logged.
namespace Claushh.Api.Notifications;

public sealed class NotificationsOptions
{
    // The absolute https URL of an ntfy topic, e.g. https://ntfy.sh/<topic>; empty: no notifications (not allowed in
    // Production).
    public string NtfyUrl { get; set; } = "";

    // An ntfy access token (tk_…), sent as Authorization: Bearer; empty: none.
    public string NtfyToken { get; set; } = "";
}
