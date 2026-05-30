const IMDS_TOKEN_URL = 'http://169.254.169.254/latest/api/token';
const IMDS_REGION_URL = 'http://169.254.169.254/latest/meta-data/placement/region';
const TIMEOUT_MS = 500;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchImdsRegion(): Promise<string | null> {
  const tokenResponse = await fetchWithTimeout(IMDS_TOKEN_URL, {
    method: 'PUT',
    headers: {
      'X-aws-ec2-metadata-token-ttl-seconds': '21600'
    }
  });

  if (!tokenResponse.ok) {
    return null;
  }

  const token = (await tokenResponse.text()).trim();
  if (!token) {
    return null;
  }

  const regionResponse = await fetchWithTimeout(IMDS_REGION_URL, {
    method: 'GET',
    headers: {
      'X-aws-ec2-metadata-token': token
    }
  });

  if (!regionResponse.ok) {
    return null;
  }

  const region = (await regionResponse.text()).trim();
  return region || null;
}

export async function getAwsRegion(): Promise<string> {
  const awsRegion = process.env.AWS_REGION?.trim();
  if (awsRegion) {
    return awsRegion;
  }

  const awsDefaultRegion = process.env.AWS_DEFAULT_REGION?.trim();
  if (awsDefaultRegion) {
    return awsDefaultRegion;
  }

  try {
    const imdsRegion = await fetchImdsRegion();
    return imdsRegion ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
