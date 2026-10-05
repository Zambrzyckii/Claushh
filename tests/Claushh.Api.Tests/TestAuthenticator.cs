// A passkey authenticator in software for the backend tests (docs/ARCHITECTURE.md, "Tests"): one ES256 credential, a
// "none" attestation and signed assertions, built byte by byte as WebAuthn defines them, so every passkey test runs
// Identity's own checks. Flags, client data, RP ID, counter and signature can be changed to make one check fail.
using System.Buffers.Binary;
using System.Buffers.Text;
using System.Formats.Cbor;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Claushh.Api.Tests;

public sealed class TestAuthenticator
{
    // Authenticator data flags (WebAuthn, "Authenticator Data").
    private const byte UserPresentFlag = 0x01;
    private const byte UserVerifiedFlag = 0x04;
    private const byte BackupEligibleFlag = 0x08;
    private const byte BackedUpFlag = 0x10;
    private const byte AttestedDataFlag = 0x40;

    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public byte[] CredentialId { get; } = RandomNumberGenerator.GetBytes(16);

    // The id as the API and the browser write it: base64url without padding.
    public string Id => Base64Url.EncodeToString(CredentialId);

    // user.id of the creation options (Identity: the user's id in UTF-8), sent back with every assertion.
    public byte[] UserHandle { get; set; } = [];

    // The signature counter: 1 at registration, one more for every assertion.
    public uint Counter { get; set; }

    public bool UserVerified { get; set; } = true;
    public bool BackupEligible { get; set; }
    public bool BackedUp { get; set; }
    public string Origin { get; set; } = TestHub.Origin;
    public bool CrossOrigin { get; set; }
    public string RpId { get; set; } = "localhost";
    public bool CorruptSignature { get; set; }

    // The credential JSON a browser sends after navigator.credentials.create() with these options.
    public JsonObject Register(JsonElement creationOptions)
    {
        UserHandle = Base64Url.DecodeFromChars(creationOptions.GetProperty("user").GetProperty("id").GetString()!);
        Counter = 1;
        var point = _key.ExportParameters(includePrivateParameters: false).Q;
        // The COSE key in the order Identity reads it: kty EC2, alg ES256, crv P-256, x, y.
        var coseKey = new CborWriter(CborConformanceMode.Ctap2Canonical);
        coseKey.WriteStartMap(5);
        coseKey.WriteInt32(1);
        coseKey.WriteInt32(2);
        coseKey.WriteInt32(3);
        coseKey.WriteInt32(-7);
        coseKey.WriteInt32(-1);
        coseKey.WriteInt32(1);
        coseKey.WriteInt32(-2);
        coseKey.WriteByteString(point.X!);
        coseKey.WriteInt32(-3);
        coseKey.WriteByteString(point.Y!);
        coseKey.WriteEndMap();
        var idLength = new byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(idLength, (ushort)CredentialId.Length);
        // A zero AAGUID, the credential id and its key; nothing may follow the key.
        byte[] authenticatorData =
            [.. AuthenticatorData(AttestedDataFlag), .. new byte[16], .. idLength, .. CredentialId, .. coseKey.Encode()];
        var attestation = new CborWriter(CborConformanceMode.Ctap2Canonical);
        attestation.WriteStartMap(3);
        attestation.WriteTextString("fmt");
        attestation.WriteTextString("none");
        attestation.WriteTextString("attStmt");
        attestation.WriteStartMap(0);
        attestation.WriteEndMap();
        attestation.WriteTextString("authData");
        attestation.WriteByteString(authenticatorData);
        attestation.WriteEndMap();
        return Credential(new JsonObject
        {
            ["clientDataJSON"] = Base64Url.EncodeToString(ClientData("webauthn.create", creationOptions)),
            ["attestationObject"] = Base64Url.EncodeToString(attestation.Encode()),
            ["authenticatorData"] = Base64Url.EncodeToString(authenticatorData),
            ["transports"] = new JsonArray("internal"),
        });
    }

    // The credential JSON a browser sends after navigator.credentials.get() with these options.
    public JsonObject Assert(JsonElement requestOptions)
    {
        Counter++;
        var clientData = ClientData("webauthn.get", requestOptions);
        var authenticatorData = AuthenticatorData(0);
        byte[] signed = [.. authenticatorData, .. SHA256.HashData(clientData)];
        var signature = _key.SignData(signed, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        if (CorruptSignature)
        {
            // Still DER, but no longer the signature of these bytes.
            signature[^1] ^= 0x01;
        }
        return Credential(new JsonObject
        {
            ["clientDataJSON"] = Base64Url.EncodeToString(clientData),
            ["authenticatorData"] = Base64Url.EncodeToString(authenticatorData),
            ["signature"] = Base64Url.EncodeToString(signature),
            ["userHandle"] = Base64Url.EncodeToString(UserHandle),
        });
    }

    // clientDataJSON as a browser writes it, with the options' challenge.
    private byte[] ClientData(string type, JsonElement options) =>
        Encoding.UTF8.GetBytes(new JsonObject
        {
            ["type"] = type,
            ["challenge"] = options.GetProperty("challenge").GetString(),
            ["origin"] = Origin,
            ["crossOrigin"] = CrossOrigin,
        }.ToJsonString());

    // The SHA-256 of the RP ID, the flags and the counter (big-endian).
    private byte[] AuthenticatorData(byte flags)
    {
        flags |= UserPresentFlag;
        if (UserVerified)
        {
            flags |= UserVerifiedFlag;
        }
        if (BackupEligible)
        {
            flags |= BackupEligibleFlag;
        }
        if (BackedUp)
        {
            flags |= BackedUpFlag;
        }
        var data = new byte[37];
        SHA256.HashData(Encoding.UTF8.GetBytes(RpId), data);
        data[32] = flags;
        BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(33), Counter);
        return data;
    }

    private JsonObject Credential(JsonObject response) => new()
    {
        ["id"] = Id,
        ["rawId"] = Id,
        ["type"] = "public-key",
        ["response"] = response,
        ["clientExtensionResults"] = new JsonObject(),
        ["authenticatorAttachment"] = "platform",
    };
}
