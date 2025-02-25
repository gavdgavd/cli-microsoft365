import { Logger } from '../../../../cli/Logger.js';
import GlobalOptions from '../../../../GlobalOptions.js';
import commands from '../../commands.js';
import { validation } from '../../../../utils/validation.js';
import SpoCommand from '../../../base/SpoCommand.js';
import request, { CliRequestOptions } from '../../../../request.js';
import { CustomAction } from '../customaction/customaction.js';
import { formatting } from '../../../../utils/formatting.js';
import { spo } from '../../../../utils/spo.js';
import { Cli } from '../../../../cli/Cli.js';

interface CommandArgs {
  options: Options;
}

interface Options extends GlobalOptions {
  webUrl: string;
  title?: string;
  id?: string;
  clientSideComponentId?: string;
  scope?: string;
  force?: boolean;
}

class SpoCommandSetRemoveCommand extends SpoCommand {
  private static readonly scopes: string[] = ['All', 'Site', 'Web'];

  public get name(): string {
    return commands.COMMANDSET_REMOVE;
  }

  public get description(): string {
    return 'Remove a ListView Command Set that is added to a site.';
  }

  constructor() {
    super();

    this.#initTelemetry();
    this.#initOptions();
    this.#initValidators();
    this.#initOptionSets();
  }

  #initTelemetry(): void {
    this.telemetry.push((args: CommandArgs) => {
      Object.assign(this.telemetryProperties, {
        title: typeof args.options.title !== 'undefined',
        id: typeof args.options.id !== 'undefined',
        clientSideComponentId: typeof args.options.clientSideComponentId !== 'undefined',
        scope: typeof args.options.scope !== 'undefined',
        force: !!args.options.force
      });
    });
  }

  #initOptions(): void {
    this.options.unshift(
      {
        option: '-u, --webUrl <webUrl>'
      },
      {
        option: '-t, --title [title]'
      },
      {
        option: '-i, --id [id]'
      },
      {
        option: '-c, --clientSideComponentId  [clientSideComponentId]'
      },
      {
        option: '-s, --scope [scope]', autocomplete: SpoCommandSetRemoveCommand.scopes
      },
      {
        option: '-f, --force'
      }
    );
  }

  #initValidators(): void {
    this.validators.push(
      async (args: CommandArgs) => {
        if (args.options.id && !validation.isValidGuid(args.options.id as string)) {
          return `${args.options.id} is not a valid GUID`;
        }

        if (args.options.clientSideComponentId && !validation.isValidGuid(args.options.clientSideComponentId as string)) {
          return `${args.options.clientSideComponentId} is not a valid GUID`;
        }

        if (args.options.scope && SpoCommandSetRemoveCommand.scopes.indexOf(args.options.scope) < 0) {
          return `${args.options.scope} is not a valid scope. Allowed values are ${SpoCommandSetRemoveCommand.scopes.join(', ')}`;
        }

        return validation.isValidSharePointUrl(args.options.webUrl);
      }
    );
  }

  #initOptionSets(): void {
    this.optionSets.push(
      { options: ['id', 'title', 'clientSideComponentId'] }
    );
  }

  public async commandAction(logger: Logger, args: CommandArgs): Promise<void> {
    if (this.verbose) {
      await logger.logToStderr(`Removing ListView Command Set ${args.options.clientSideComponentId || args.options.title || args.options.id} to site '${args.options.webUrl}'...`);
    }

    if (args.options.force) {
      await this.deleteCommandset(args);
    }
    else {
      const result = await Cli.promptForConfirmation({ message: `Are you sure you want to remove command set '${args.options.clientSideComponentId || args.options.title || args.options.id}'?` });

      if (result) {
        await this.deleteCommandset(args);
      }
    }
  }

  private async getCustomAction(options: Options): Promise<CustomAction> {
    let commandSets: CustomAction[] = [];

    if (options.id) {
      const commandSet = await spo.getCustomActionById(options.webUrl, options.id, options.scope);
      if (commandSet) {
        commandSets.push(commandSet);
      }
    }
    else if (options.title) {
      commandSets = await spo.getCustomActions(options.webUrl, options.scope, `(Title eq '${formatting.encodeQueryParameter(options.title as string)}') and (startswith(Location,'ClientSideExtension.ListViewCommandSet'))`);
    }
    else {
      commandSets = await spo.getCustomActions(options.webUrl, options.scope, `(ClientSideComponentId eq guid'${options.clientSideComponentId}') and (startswith(Location,'ClientSideExtension.ListViewCommandSet'))`);
    }

    if (commandSets.length === 0) {
      throw `No user commandsets with ${options.title && `title '${options.title}'` || options.clientSideComponentId && `ClientSideComponentId '${options.clientSideComponentId}'` || options.id && `id '${options.id}'`} found`;
    }

    if (commandSets.length > 1) {
      const resultAsKeyValuePair = formatting.convertArrayToHashTable('Id', commandSets);
      return await Cli.handleMultipleResultsFound<CustomAction>(`Multiple user commandsets with ${options.title ? `title '${options.title}'` : `ClientSideComponentId '${options.clientSideComponentId}'`} found.`, resultAsKeyValuePair);
    }

    return commandSets[0];
  }

  private async deleteCommandset(args: CommandArgs): Promise<void> {
    if (!args.options.scope) {
      args.options.scope = 'All';
    }

    try {
      const customAction = await this.getCustomAction(args.options);

      const requestOptions: CliRequestOptions = {
        url: `${args.options.webUrl}/_api/${customAction.Scope === 3 ? "Web" : "Site"}/UserCustomActions('${formatting.encodeQueryParameter(customAction.Id)}')`,
        headers: {
          accept: 'application/json;odata=nometadata'
        },
        responseType: 'json'
      };

      await request.delete<CustomAction>(requestOptions);
    }
    catch (err: any) {
      this.handleRejectedODataJsonPromise(err);
    }
  }
}

export default new SpoCommandSetRemoveCommand();