import type { Page, Response } from '@playwright/test';

/** Twin type id the ops app uses for operations (plants). */
const OPERATION_TWIN_TYPE_ID = 'e5d5ea04-64da-49c7-8887-7c6039ba239b';

/** A node in the app's digital-twin hierarchy: a tenant or an operation. */
export interface TwinNode {
  id: number;
  name: string;
  twinTypeId: string;
  /** The GUID the ops app puts in its routes, e.g. `/ops/plant/<id>/`. */
  twinReferenceId: string;
  /** Materialised ancestor path, e.g. `/1/4/3/20477/123/2/`. */
  twinNodePath: string;
  parentId: number | null;
}

/** An operation resolved to everything the audit needs to visit and name it. */
export interface Operation extends TwinNode {
  /** Immediate parent's name — the only thing distinguishing same-named plants. */
  parentName: string;
}

const DESCENDANTS_PATTERN = /digitaltwin\/\d+\/type\/[0-9a-f-]+\/descendants/i;

/**
 * The operation hierarchy behind the toolbar's operation picker.
 *
 * The app loads the whole tree up front to populate that picker, so rather than
 * driving the picker once per plant — which costs a search and a full tree
 * expansion every time — this reads the same payload the picker is built from
 * and resolves operations to their route GUIDs directly.
 *
 * Only operations the signed-in user can reach are present: tenant membership
 * is carried in the token, so access granted after sign-in does not appear here
 * until the `setup` project is re-run.
 */
export class OperationDirectory {
  private constructor(private readonly nodes: TwinNode[]) {}

  /**
   * Capture the tree while `navigate` loads the app.
   *
   * The tree is fetched once during boot and never refetched, so the listener
   * has to be attached before navigating rather than after.
   */
  static async capture(
    page: Page,
    navigate: () => Promise<void>,
  ): Promise<OperationDirectory> {
    const nodes: TwinNode[] = [];
    const pending: Promise<void>[] = [];

    const onResponse = (response: Response) => {
      if (!DESCENDANTS_PATTERN.test(response.url())) return;
      pending.push(
        response
          .json()
          .then((body) => {
            for (const item of body?.content?.digitalTwins?.items ?? []) {
              nodes.push(item as TwinNode);
            }
          })
          .catch(() => {
            // A response we cannot read tells us nothing; the emptiness check
            // below is what turns a total failure into a clear error.
          }),
      );
    };

    page.on('response', onResponse);
    try {
      await navigate();
    } finally {
      page.off('response', onResponse);
    }
    await Promise.all(pending);

    if (nodes.length === 0) {
      throw new Error(
        'No digital-twin hierarchy was captured while loading the app. The ' +
          'operation tree is only fetched during boot, so capture() must wrap ' +
          'the navigation that loads it.',
      );
    }
    return new OperationDirectory(nodes);
  }

  /** Every captured node, tenants included. */
  get all(): readonly TwinNode[] {
    return this.nodes;
  }

  /** Find a node by its exact name. */
  findByName(name: string): TwinNode | undefined {
    return this.nodes.find((node) => node.name === name);
  }

  /**
   * Every operation beneath `tenantName`, optionally filtered by name prefix.
   *
   * Descent is by materialised path, so this reaches operations at any depth
   * rather than only direct children.
   */
  operationsUnder(tenantName: string, namePrefix = ''): Operation[] {
    const tenant = this.findByName(tenantName);
    if (!tenant) {
      const tenantCount = this.nodes.filter(
        (node) => node.twinTypeId?.toLowerCase() !== OPERATION_TWIN_TYPE_ID,
      ).length;
      throw new Error(
        `No tenant named "${tenantName}" is visible to this user ` +
          `(${tenantCount} tenant(s) visible). Tenant membership is carried in ` +
          `the auth token, so if access was granted recently, re-run the ` +
          `'setup' project to pick it up.`,
      );
    }

    const byId = new Map(this.nodes.map((node) => [node.id, node]));

    return this.nodes
      .filter(
        (node) =>
          node.twinTypeId?.toLowerCase() === OPERATION_TWIN_TYPE_ID &&
          node.id !== tenant.id &&
          node.twinNodePath?.startsWith(tenant.twinNodePath) &&
          node.name?.startsWith(namePrefix),
      )
      .map((node) => ({
        ...node,
        parentName:
          (node.parentId !== null ? byId.get(node.parentId)?.name : undefined) ??
          '(unknown)',
      }))
      .sort(
        (a, b) =>
          a.parentName.localeCompare(b.parentName, undefined, {
            numeric: true,
          }) || a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
  }
}
