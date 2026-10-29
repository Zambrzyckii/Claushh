// The {"message": "..."} body of the API's error and status answers (docs/ARCHITECTURE.md, "Backend").
namespace Claushh.Api.Web;

public sealed record MessageResponse(string Message);
