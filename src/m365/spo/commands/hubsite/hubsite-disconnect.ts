import { Cli } from '../../../../cli/Cli.js';
import { Logger } from '../../../../cli/Logger.js';
import GlobalOptions from '../../../../GlobalOptions.js';
import request, { CliRequestOptions } from '../../../../request.js';
import { formatting } from '../../../../utils/formatting.js';
import { spo } from '../../../../utils/spo.js';
import { validation } from '../../../../utils/validation.js';
import SpoCommand from '../../../base/SpoCommand.js';
import commands from '../../commands.js';
import { HubSite } from './HubSite.js';

interface CommandArgs {
  options: Options;
}

interface Options extends GlobalOptions {
  id?: string;
  title?: string;
  url?: string;
  force?: boolean;
}

class SpoHubSiteDisconnectCommand extends SpoCommand {
  public get name(): string {
    return commands.HUBSITE_DISCONNECT;
  }

  public get description(): string {
    return 'Disconnect a hub site from its parent hub site';
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
        id: typeof args.options.id !== 'undefined',
        title: typeof args.options.title !== 'undefined',
        url: typeof args.options.url !== 'undefined'
      });
    });
  }

  #initOptions(): void {
    this.options.unshift(
      {
        option: '-i, --id [id]'
      },
      {
        option: '-t, --title [title]'
      },
      {
        option: '-u, --url [url]'
      },
      {
        option: '-f, --force'
      }
    );
  }

  #initOptionSets(): void {
    this.optionSets.push(
      { options: ['id', 'title', 'url'] }
    );
  }

  #initValidators(): void {
    this.validators.push(
      async (args: CommandArgs) => {
        if (args.options.id && !validation.isValidGuid(args.options.id)) {
          return `'${args.options.id}' is not a valid GUID`;
        }

        if (args.options.url) {
          const isValidSharePointUrl = validation.isValidSharePointUrl(args.options.url);

          if (isValidSharePointUrl !== true) {
            return isValidSharePointUrl;
          }
        }

        return true;
      }
    );
  }

  public async commandAction(logger: Logger, args: CommandArgs): Promise<void> {
    const disconnectHubSite = async (): Promise<void> => {
      try {
        if (this.verbose) {
          await logger.logToStderr(`Disconnecting hub site '${args.options.id || args.options.title || args.options.url}' from its parent hub site...`);
        }

        const spoAdminUrl = await spo.getSpoAdminUrl(logger, this.debug);
        const hubSite = await this.getHubSite(spoAdminUrl, args.options);

        const requestOptions: CliRequestOptions = {
          url: `${spoAdminUrl}/_api/HubSites/GetById('${hubSite.ID}')`,
          headers: {
            accept: 'application/json;odata=nometadata',
            'if-match': hubSite['odata.etag']
          },
          responseType: 'json',
          data: {
            ParentHubSiteId: '00000000-0000-0000-0000-000000000000'
          }
        };

        await request.patch(requestOptions);
      }
      catch (err: any) {
        this.handleRejectedODataJsonPromise(err);
      }
    };

    if (args.options.force) {
      await disconnectHubSite();
    }
    else {
      const result = await Cli.promptForConfirmation({ message: `Are you sure you want disconnect hub site '${args.options.id || args.options.title || args.options.url}' from its parent hub site?` });

      if (result) {
        await disconnectHubSite();
      }
    }
  }

  private async getHubSite(spoAdminUrl: string, options: Options): Promise<{ 'odata.etag': string, ID: string }> {
    const requestOptions: CliRequestOptions = {
      headers: {
        accept: 'application/json;odata=minimalmetadata'
      },
      responseType: 'json'
    };

    if (options.id) {
      requestOptions.url = `${spoAdminUrl}/_api/HubSites/GetById('${options.id}')?$select=ID`;

      const result = await request.get<{ 'odata.etag': string, ID: string }>(requestOptions);
      return result;
    }

    requestOptions.url = `${spoAdminUrl}/_api/HubSites?$select=ID,Title,SiteUrl&$top=5000`;
    const hubSitesResponse = await request.get<{ value: HubSite[] }>(requestOptions);
    const hubSites = hubSitesResponse.value;

    let filteredHubSites: HubSite[] = [];
    if (options.title) {
      filteredHubSites = hubSites.filter(site => site.Title.toLowerCase() === options.title!.toLowerCase());
    }
    else if (options.url) {
      filteredHubSites = hubSites.filter(site => site.SiteUrl.toLowerCase() === options.url!.toLowerCase());
    }

    if (filteredHubSites.length === 0) {
      throw `The specified hub site '${options.title || options.url}' does not exist.`;
    }

    if (filteredHubSites.length > 1) {
      const resultAsKeyValuePair = formatting.convertArrayToHashTable('ID', filteredHubSites);
      const result = await Cli.handleMultipleResultsFound<HubSite>(`Multiple hub sites with name '${options.title}' found.`, resultAsKeyValuePair);
      return result as { 'odata.etag': string, ID: string };
    }

    return filteredHubSites[0] as { 'odata.etag': string, ID: string };
  }
}

export default new SpoHubSiteDisconnectCommand();