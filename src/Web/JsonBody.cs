// null for a body that is missing, not JSON or of the wrong shape. Read by hand, as in AuthEndpoints.Logout: with an
// inferred JSON body, routing skips the endpoint for a request without a JSON content type, and the catch-all /api
// route would answer 404 instead.
using System.Text.Json;

namespace Claushh.Api.Web;

public static class JsonBody
{
    public static async Task<T?> ReadAsync<T>(HttpContext http) where T : class
    {
        if (!http.Request.HasJsonContentType())
        {
            return null;
        }
        try
        {
            return await http.Request.ReadFromJsonAsync<T>(http.RequestAborted);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
