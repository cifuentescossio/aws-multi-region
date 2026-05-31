import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface EcrBackend {
  /** Logical key, e.g. "v1" or "v2". */
  key: string;
  /** ECR repository name (host part comes from the region/account at push time). */
  name: string;
}

export interface EcrArgs {
  /** One repository per backend (v1, v2, ...). */
  backends: EcrBackend[];
  /** IMMUTABLE blocks overwriting an existing tag (recommended). */
  imageTagMutability?: "MUTABLE" | "IMMUTABLE";
  /** Trigger a basic vulnerability scan on every push. */
  scanOnPush?: boolean;
  /** Keep only the most recent N images; older ones are expired by a lifecycle policy. */
  maxImageCount?: number;
  tags?: Record<string, string>;
}

/**
 * Per-backend ECR repositories, one copy per region (each region pulls locally).
 * Created unconditionally: the repo must exist before an image can be pushed.
 */
export class EcrComponent extends pulumi.ComponentResource {
  /** Repositories keyed by backend key. */
  public readonly repositories: { key: string; repository: aws.ecr.Repository }[] = [];
  /** Map of backend key -> repository URI (host/name, no tag). */
  public readonly repositoryUrls: pulumi.Output<Record<string, string>>;

  constructor(name: string, args: EcrArgs, opts?: pulumi.ComponentResourceOptions) {
    super("aws-multi-region:ecr:Registry", name, {}, opts);

    const childOpts = { parent: this };
    const baseTags = args.tags ?? {};
    const mutability = args.imageTagMutability ?? "IMMUTABLE";
    const scanOnPush = args.scanOnPush ?? true;
    const maxImageCount = args.maxImageCount ?? 20;

    if (args.backends.length === 0) {
      throw new pulumi.RunError(`ECR registry '${name}' requires at least one backend.`);
    }

    for (const backend of args.backends) {
      const repository = new aws.ecr.Repository(
        `${name}-${backend.key}`,
        {
          name: backend.name,
          imageTagMutability: mutability,
          imageScanningConfiguration: { scanOnPush },
          // Untag the repo cleanly on `pulumi destroy` even if images remain.
          forceDelete: true,
          encryptionConfigurations: [{ encryptionType: "AES256" }],
          tags: { ...baseTags, Name: backend.name },
        },
        childOpts,
      );

      // Expire all but the most recent N images so the repo doesn't grow forever.
      new aws.ecr.LifecyclePolicy(
        `${name}-${backend.key}-lifecycle`,
        {
          repository: repository.name,
          policy: JSON.stringify({
            rules: [
              {
                rulePriority: 1,
                description: `Keep only the last ${maxImageCount} images`,
                selection: {
                  tagStatus: "any",
                  countType: "imageCountMoreThan",
                  countNumber: maxImageCount,
                },
                action: { type: "expire" },
              },
            ],
          }),
        },
        childOpts,
      );

      this.repositories.push({ key: backend.key, repository });
    }

    this.repositoryUrls = pulumi
      .all(
        this.repositories.map((r) =>
          r.repository.repositoryUrl.apply((url) => [r.key, url] as [string, string]),
        ),
      )
      .apply((entries) => Object.fromEntries(entries));

    this.registerOutputs({
      repository_urls: this.repositoryUrls,
    });
  }
}
