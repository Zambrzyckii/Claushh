// Binds the XSRF token to one session, not only to the user: ASP.NET binds it to the user's claims, so without this
// a token from an old session of the same user would still pass (docs/ARCHITECTURE.md, "API contract").
using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;

namespace Claushh.Api.Auth;

public sealed class SessionAntiforgeryData : IAntiforgeryAdditionalDataProvider
{
    public string GetAdditionalData(HttpContext context) =>
        context.User.FindFirstValue(SessionAuthenticationHandler.SessionIdClaim) ?? "";

    public bool ValidateAdditionalData(HttpContext context, string additionalData) =>
        additionalData == GetAdditionalData(context);
}
