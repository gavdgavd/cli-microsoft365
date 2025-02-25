import { Cli } from '../../../../cli/Cli.js';
import { Logger } from '../../../../cli/Logger.js';
import config from '../../../../config.js';
import GlobalOptions from '../../../../GlobalOptions.js';
import request from '../../../../request.js';
import { formatting } from '../../../../utils/formatting.js';
import { ClientSvcResponse, ClientSvcResponseContents, IdentityResponse, spo } from '../../../../utils/spo.js';
import { validation } from '../../../../utils/validation.js';
import commands from '../../commands.js';
import { SpoPropertyBagBaseCommand } from './propertybag-base.js';

interface CommandArgs {
  options: Options;
}

interface Options extends GlobalOptions {
  webUrl: string;
  key: string;
  folder?: string;
  force?: boolean;
}

class SpoPropertyBagRemoveCommand extends SpoPropertyBagBaseCommand {
  public get name(): string {
    return commands.PROPERTYBAG_REMOVE;
  }

  public get description(): string {
    return 'Removes specified property from the property bag';
  }

  constructor() {
    super();

    this.#initTelemetry();
    this.#initOptions();
    this.#initValidators();
  }

  #initTelemetry(): void {
    this.telemetry.push((args: CommandArgs) => {
      Object.assign(this.telemetryProperties, {
        folder: (!(!args.options.folder)).toString(),
        force: args.options.force === true
      });
    });
  }

  #initOptions(): void {
    this.options.unshift(
      {
        option: '-u, --webUrl <webUrl>'
      },
      {
        option: '-k, --key <key>'
      },
      {
        option: '--folder [folder]'
      },
      {
        option: '-f, --force'
      }
    );
  }

  #initValidators(): void {
    this.validators.push(
      async (args: CommandArgs) => validation.isValidSharePointUrl(args.options.webUrl)
    );
  }

  public async commandAction(logger: Logger, args: CommandArgs): Promise<void> {
    if (args.options.force) {
      await this.removeProperty(args);
    }
    else {
      const result = await Cli.promptForConfirmation({ message: `Are you sure you want to remove the ${args.options.key} property?` });

      if (result) {
        await this.removeProperty(args);
      }
    }
  }

  private async removeProperty(args: CommandArgs): Promise<void> {
    try {
      const contextResponse = await spo.getRequestDigest(args.options.webUrl);
      this.formDigestValue = contextResponse.FormDigestValue;

      let identityResp = await spo.getCurrentWebIdentity(args.options.webUrl, this.formDigestValue);
      const opts: Options = args.options;
      if (opts.folder) {
        // get the folder guid instead of the web guid
        identityResp = await spo.getFolderIdentity(identityResp.objectIdentity, opts.webUrl, opts.folder, this.formDigestValue);
      }

      await this.removePropertyWithIdentityResp(identityResp, args.options);
    }
    catch (err: any) {
      this.handleRejectedPromise(err);
    }
  }

  private async removePropertyWithIdentityResp(identityResp: IdentityResponse, options: Options): Promise<any> {
    let objectType: string = 'AllProperties';
    if (options.folder) {
      objectType = 'Properties';
    }

    const requestOptions: any = {
      url: `${options.webUrl}/_vti_bin/client.svc/ProcessQuery`,
      headers: {
        'X-RequestDigest': this.formDigestValue
      },
      data: `<Request AddExpandoFieldTypeSuffix="true" SchemaVersion="15.0.0.0" LibraryVersion="16.0.0.0" ApplicationName="${config.applicationName}" xmlns="http://schemas.microsoft.com/sharepoint/clientquery/2009"><Actions><Method Name="SetFieldValue" Id="206" ObjectPathId="205"><Parameters><Parameter Type="String">${formatting.escapeXml(options.key)}</Parameter><Parameter Type="Null" /></Parameters></Method><Method Name="Update" Id="207" ObjectPathId="198" /></Actions><ObjectPaths><Property Id="205" ParentId="198" Name="${objectType}" /><Identity Id="198" Name="${identityResp.objectIdentity}" /></ObjectPaths></Request>`
    };

    const res: any = await request.post(requestOptions);

    const json: ClientSvcResponse = JSON.parse(res);
    const contents: ClientSvcResponseContents = json.find(x => { return x['ErrorInfo']; });
    if (contents && contents.ErrorInfo) {
      throw contents.ErrorInfo.ErrorMessage || 'ClientSvc unknown error';
    }
    else {
      return res;
    }
  }
}

export default new SpoPropertyBagRemoveCommand();