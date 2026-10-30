// GET /api/terminal/theme (docs/ARCHITECTURE.md, "Terminal" → "Terminal theme API contract"): pywal's colours for the
// terminal, or 204 with an empty body. In the /api group: a session is needed, and a GET passes the XSRF rule.
using Microsoft.Extensions.Options;

namespace Claushh.Api.Terminal;

public static class TerminalEndpoints
{
    public static RouteGroupBuilder MapTerminalEndpoints(this RouteGroupBuilder api)
    {
        api.MapGet("/terminal/theme", Theme);
        return api;
    }

    // Terminal:ThemeFile is read on every request, so a new palette reaches the next terminal without a restart.
    private static IResult Theme(IOptions<TerminalOptions> options) =>
        TerminalTheme.Read(options.Value.ThemeFile) is { } theme ? Results.Ok(theme) : Results.NoContent();
}
