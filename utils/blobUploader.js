// utils/blobUploader.js
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
require("dotenv").config();

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!CONN) throw new Error("Azure Storage connection string is not set in .env");

// Parse AccountName & AccountKey from connection string for SAS signing
function parseConnString(cs) {
  const parts = Object.fromEntries(
    cs.split(";").map(kv => {
      const [k, ...rest] = kv.split("=");
      return [k, rest.join("=")];
    })
  );
  return {
    accountName: parts.AccountName,
    accountKey: parts.AccountKey,
  };
}

const { accountName, accountKey } = parseConnString(CONN);
if (!accountName || !accountKey) {
  throw new Error("AccountName/AccountKey missing from AZURE_STORAGE_CONNECTION_STRING");
}

const blobServiceClient = BlobServiceClient.fromConnectionString(CONN);
const containerName = "expenses"; // must be lowercase
const containerClient = blobServiceClient.getContainerClient(containerName);

/** Sanitize file name */
function sanitizeFileName(fileName) {
  return fileName
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/\.+$/, "")
    .substring(0, 100);
}

function buildReadOnlyBlobSAS(container, blobName, minutes = 60 * 24) {
  const cred = new StorageSharedKeyCredential(accountName, accountKey);
  const startsOn = new Date(Date.now() - 5 * 60 * 1000); // backdate 5 min
  const expiresOn = new Date(Date.now() + minutes * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: container,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
    },
    cred
  ).toString();

  const baseUrl = `https://${accountName}.blob.core.windows.net/${container}/${encodeURIComponent(blobName)}`;
  return `${baseUrl}?${sas}`;
}

/**
 * Uploads a buffer to blob storage and returns { url, sasUrl, fileName }
 * - url: plain URL (won't work if account forbids public access)
 * - sasUrl: signed URL (works with private containers)
 */
async function uploadToBlob(fileBuffer, originalFileName, contentType = "application/octet-stream") {
  try {
    // Ensure container exists (remains private by default)
    const exists = await containerClient.exists();
    if (!exists) {
      await containerClient.create();
      // DO NOT set public access since your account forbids it.
      console.log(`Created container: ${containerName}`);
    }

    const sanitizedFileName = sanitizeFileName(path.basename(originalFileName || "upload.bin"));
    const uniqueFileName = `${uuidv4()}-${sanitizedFileName}`;
    const blockBlobClient = containerClient.getBlockBlobClient(uniqueFileName);

    await blockBlobClient.uploadData(fileBuffer, {
      blobHTTPHeaders: {
        blobContentType: contentType, // use actual mimetype
      },
    });

    const plainUrl = blockBlobClient.url; // will 403 if public access disabled
    const sasUrl = buildReadOnlyBlobSAS(containerName, uniqueFileName, 60 * 24); // 24h

    console.log("Uploaded:", uniqueFileName);
    return {
      fileName: uniqueFileName,
      url: plainUrl,
      sasUrl,
    };
  } catch (err) {
    console.error("Error uploading to Azure Blob:", err.message);
    throw err;
  }
}


/**
 * Generates a SAS URL from a plain blob URL
 */
function getSasUrlFromBlobUrl(plainUrl) {
  try {
    const urlObj = new URL(plainUrl);
    // Path structure: /container/blobName
    // We expect: /expenses/unique-filename
    const pathname = urlObj.pathname;
    
    // Remove leading slash
    const pathParts = pathname.startsWith("/") ? pathname.slice(1).split("/") : pathname.split("/");
    
    // Need at least container and blob name
    if (pathParts.length < 2) {
      throw new Error("Invalid blob URL format");
    }

    const container = pathParts[0];
    // Join the rest in case blob name has slashes (though uuid ones usually don't, but good practice)
    const blobName = decodeURIComponent(pathParts.slice(1).join("/"));

    return buildReadOnlyBlobSAS(container, blobName, 60 * 24);
  } catch (error) {
    console.error("Error generating SAS from URL:", error);
    return null;
  }
}

module.exports = uploadToBlob;
module.exports.getSasUrlFromBlobUrl = getSasUrlFromBlobUrl;
