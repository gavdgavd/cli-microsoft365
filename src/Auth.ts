import { AzureCloudInstance, DeviceCodeResponse } from '@azure/msal-common';
import type * as Msal from '@azure/msal-node';
import type clipboard from 'clipboardy';
import type NodeForge from 'node-forge';
import type { AuthServer } from './AuthServer.js';
import { CommandError } from './Command.js';
import { FileTokenStorage } from './auth/FileTokenStorage.js';
import { TokenStorage } from './auth/TokenStorage.js';
import { msalCachePlugin } from './auth/msalCachePlugin.js';
import { Cli } from './cli/Cli.js';
import { Logger } from './cli/Logger.js';
import config from './config.js';
import request from './request.js';
import { settingsNames } from './settingsNames.js';
import { browserUtil } from './utils/browserUtil.js';

interface Hash<TValue> {
  [key: string]: TValue;
}

interface AccessToken {
  expiresOn: Date | string | null;
  accessToken: string;
}

export interface InteractiveAuthorizationCodeResponse {
  code: string;
  redirectUri: string;
}

export interface InteractiveAuthorizationErrorResponse {
  error: string;
  errorDescription: string;
}

export enum CloudType {
  Public,
  USGov,
  USGovHigh,
  USGovDoD,
  China
}

export class Service {
  connected: boolean = false;
  authType: AuthType = AuthType.DeviceCode;
  userName?: string;
  password?: string;
  secret?: string;
  certificateType: CertificateType = CertificateType.Unknown;
  certificate?: string;
  thumbprint?: string;
  accessTokens: Hash<AccessToken>;
  spoUrl?: string;
  tenantId?: string;
  // ID of the Azure AD app used to authenticate
  appId: string;
  // ID of the tenant where the Azure AD app is registered; common if multitenant
  tenant: string;
  cloudType: CloudType = CloudType.Public;

  constructor() {
    this.accessTokens = {};
    this.appId = config.cliAadAppId;
    this.tenant = config.tenant;
    this.cloudType = CloudType.Public;
  }

  public logout(): void {
    this.connected = false;
    this.accessTokens = {};
    this.authType = AuthType.DeviceCode;
    this.userName = undefined;
    this.password = undefined;
    this.certificateType = CertificateType.Unknown;
    this.certificate = undefined;
    this.thumbprint = undefined;
    this.spoUrl = undefined;
    this.tenantId = undefined;
    this.appId = config.cliAadAppId;
    this.tenant = config.tenant;
  }
}

export enum AuthType {
  DeviceCode,
  Password,
  Certificate,
  Identity,
  Browser,
  Secret
}

export enum CertificateType {
  Unknown,
  Base64,
  Binary
}

export class Auth {
  private _clipboardy: typeof clipboard | undefined;
  private _authServer: AuthServer | undefined;
  private deviceCodeRequest?: Msal.DeviceCodeRequest;
  private _service: Service;
  private clientApplication: Msal.ClientApplication | undefined;
  private static cloudEndpoints: any[] = [];

  public get service(): Service {
    return this._service;
  }

  public get defaultResource(): string {
    return Auth.getEndpointForResource('https://graph.microsoft.com', this._service.cloudType);
  }

  constructor() {
    this._service = new Service();
  }

  // we need to init cloud endpoints here, because we're using CloudType enum
  // as indexers, which we can't do in the static initializer
  // it also needs to be a separate method that we call here, because in tests
  // we're mocking auth and calling its constructor
  public static initialize(): void {
    this.cloudEndpoints[CloudType.USGov] = {
      'https://graph.microsoft.com': 'https://graph.microsoft.com',
      'https://graph.windows.net': 'https://graph.windows.net',
      'https://management.azure.com/': 'https://management.usgovcloudapi.net/',
      'https://login.microsoftonline.com': 'https://login.microsoftonline.com'
    };
    this.cloudEndpoints[CloudType.USGovHigh] = {
      'https://graph.microsoft.com': 'https://graph.microsoft.us',
      'https://graph.windows.net': 'https://graph.windows.net',
      'https://management.azure.com/': 'https://management.usgovcloudapi.net/',
      'https://login.microsoftonline.com': 'https://login.microsoftonline.us'
    };
    this.cloudEndpoints[CloudType.USGovDoD] = {
      'https://graph.microsoft.com': 'https://dod-graph.microsoft.us',
      'https://graph.windows.net': 'https://graph.windows.net',
      'https://management.azure.com/': 'https://management.usgovcloudapi.net/',
      'https://login.microsoftonline.com': 'https://login.microsoftonline.us'
    };
    this.cloudEndpoints[CloudType.China] = {
      'https://graph.microsoft.com': 'https://microsoftgraph.chinacloudapi.cn',
      'https://graph.windows.net': 'https://graph.chinacloudapi.cn',
      'https://management.azure.com/': 'https://management.chinacloudapi.cn',
      'https://login.microsoftonline.com': 'https://login.chinacloudapi.cn'
    };
  }

  public async restoreAuth(): Promise<void> {
    // check if auth has been restored previously
    if (this._service.connected) {
      return Promise.resolve();
    }

    try {
      const service: Service = await this.getServiceConnectionInfo<Service>();
      this._service = Object.assign(this._service, service);
    }
    catch {
    }
  }

  public async ensureAccessToken(resource: string, logger: Logger, debug: boolean = false, fetchNew: boolean = false): Promise<string> {
    const now: Date = new Date();
    const accessToken: AccessToken | undefined = this.service.accessTokens[resource];
    const expiresOn: Date = accessToken && accessToken.expiresOn ?
      // if expiresOn is serialized from the service file, it's set as a string
      // if it's coming from MSAL, it's a Date
      typeof accessToken.expiresOn === 'string' ? new Date(accessToken.expiresOn) : accessToken.expiresOn
      : new Date(0);

    if (!fetchNew && accessToken && expiresOn > now) {
      if (debug) {
        await logger.logToStderr(`Existing access token ${accessToken.accessToken} still valid. Returning...`);
      }
      return accessToken.accessToken;
    }
    else {
      if (debug) {
        if (!accessToken) {
          await logger.logToStderr(`No token found for resource ${resource}`);
        }
        else {
          await logger.logToStderr(`Access token expired. Token: ${accessToken.accessToken}, ExpiresAt: ${accessToken.expiresOn}`);
        }
      }
    }

    let getTokenPromise: ((resource: string, logger: Logger, debug: boolean, fetchNew: boolean) => Promise<AccessToken | null>) | undefined;

    // when using cert, you can't retrieve token silently, because there is
    // no account. Also cert auth instantiates clientApplication itself
    // after inspecting the specified cert and calculating thumbprint if one
    // wasn't specified
    if (this.service.authType !== AuthType.Certificate) {
      this.clientApplication = await this.getClientApplication(logger, debug);
      if (this.clientApplication) {
        const accounts = await this.clientApplication.getTokenCache().getAllAccounts();
        if (accounts.length > 0) {
          getTokenPromise = this.ensureAccessTokenSilent.bind(this);
        }
      }
    }

    if (!getTokenPromise) {
      switch (this.service.authType) {
        case AuthType.DeviceCode:
          getTokenPromise = this.ensureAccessTokenWithDeviceCode.bind(this);
          break;
        case AuthType.Password:
          getTokenPromise = this.ensureAccessTokenWithPassword.bind(this);
          break;
        case AuthType.Certificate:
          getTokenPromise = this.ensureAccessTokenWithCertificate.bind(this);
          break;
        case AuthType.Identity:
          getTokenPromise = this.ensureAccessTokenWithIdentity.bind(this);
          break;
        case AuthType.Browser:
          getTokenPromise = this.ensureAccessTokenWithBrowser.bind(this);
          break;
        case AuthType.Secret:
          getTokenPromise = this.ensureAccessTokenWithSecret.bind(this);
          break;
      }
    }

    const response = await getTokenPromise(resource, logger, debug, fetchNew);
    if (!response) {
      if (debug) {
        await logger.logToStderr(`getTokenPromise authentication result is null`);
      }
      throw `Failed to retrieve an access token. Please try again`;
    }
    else {
      if (debug) {
        await logger.logToStderr('Response');
        await logger.logToStderr(response);
        await logger.logToStderr('');
      }
    }

    this.service.accessTokens[resource] = {
      expiresOn: response.expiresOn,
      accessToken: response.accessToken
    };
    this.service.connected = true;
    try {
      await this.storeConnectionInfo();
    }
    catch (ex: any) {
      // error could happen due to an issue with persisting the access
      // token which shouldn't fail the overall token retrieval process
      if (debug) {
        await logger.logToStderr(new CommandError(ex));
      }
    }
    return response.accessToken;
  }

  private async getClientApplication(logger: Logger, debug: boolean): Promise<Msal.ClientApplication | undefined> {
    switch (this.service.authType) {
      case AuthType.DeviceCode:
      case AuthType.Password:
      case AuthType.Browser:
        return await this.getPublicClient(logger, debug);
      case AuthType.Certificate:
        return await this.getConfidentialClient(logger, debug, this.service.thumbprint as string, this.service.password, undefined);
      case AuthType.Identity:
        // msal-node doesn't support managed identity so we need to do it manually
        return undefined;
      case AuthType.Secret:
        return await this.getConfidentialClient(logger, debug, undefined, undefined, this.service.secret);
    }
  }

  private async getAuthClientConfiguration(logger: Logger, debug: boolean, certificateThumbprint?: string, certificatePrivateKey?: string, clientSecret?: string): Promise<Msal.Configuration> {
    const msal: typeof Msal = await import('@azure/msal-node');
    const { LogLevel } = msal;
    const cert = !certificateThumbprint ? undefined : {
      thumbprint: certificateThumbprint,
      privateKey: certificatePrivateKey as string
    };

    let azureCloudInstance: AzureCloudInstance = 0;
    switch (this.service.cloudType) {
      case CloudType.Public:
        azureCloudInstance = AzureCloudInstance.AzurePublic;
        break;
      case CloudType.China:
        azureCloudInstance = AzureCloudInstance.AzureChina;
        break;
      case CloudType.USGov:
      case CloudType.USGovHigh:
      case CloudType.USGovDoD:
        azureCloudInstance = AzureCloudInstance.AzureUsGovernment;
        break;
    }

    const config = {
      clientId: this.service.appId,
      authority: `${Auth.getEndpointForResource('https://login.microsoftonline.com', this.service.cloudType)}/${this.service.tenant}`,
      azureCloudOptions: {
        azureCloudInstance,
        tenant: this.service.tenant
      }
    };

    const authConfig = cert
      ? { ...config, clientCertificate: cert }
      : { ...config, clientSecret };

    return {
      auth: authConfig,
      cache: {
        cachePlugin: msalCachePlugin
      },
      system: {
        loggerOptions: {
          // loggerCallback is called by MSAL which we're not testing
          /* c8 ignore next 4 */
          loggerCallback: async (level: Msal.LogLevel, message: string) => {
            if (level === LogLevel.Error || debug) {
              await logger.logToStderr(message);
            }
          },
          piiLoggingEnabled: false,
          logLevel: debug ? LogLevel.Verbose : LogLevel.Error
        }
      }
    };
  }

  private async getPublicClient(logger: Logger, debug: boolean): Promise<Msal.PublicClientApplication> {
    const msal: typeof Msal = await import('@azure/msal-node');
    const { PublicClientApplication } = msal;

    if (this.service.authType === AuthType.Password &&
      this.service.tenant === 'common') {
      // common is not supported for the password flow and must be changed to
      // organizations
      this.service.tenant = 'organizations';
    }

    return new PublicClientApplication(await this.getAuthClientConfiguration(logger, debug));
  }

  private async getConfidentialClient(logger: Logger, debug: boolean, certificateThumbprint?: string, certificatePrivateKey?: string, clientSecret?: string): Promise<Msal.ConfidentialClientApplication> {
    const msal: typeof Msal = await import('@azure/msal-node');
    const { ConfidentialClientApplication } = msal;

    return new ConfidentialClientApplication(await this.getAuthClientConfiguration(logger, debug, certificateThumbprint, certificatePrivateKey, clientSecret));
  }

  private retrieveAuthCodeWithBrowser(resource: string, logger: Logger, debug: boolean): Promise<InteractiveAuthorizationCodeResponse> {
    return new Promise<InteractiveAuthorizationCodeResponse>(async (resolve: (error: InteractiveAuthorizationCodeResponse) => void, reject: (error: InteractiveAuthorizationErrorResponse) => void): Promise<void> => {
      // _authServer is never set before hitting this line, but this check
      // is implemented so that we can support lazy loading
      // but also stub it for testing
      /* c8 ignore next 3 */
      if (!this._authServer) {
        this._authServer = (await import('./AuthServer.js')).default;
      }

      (this._authServer as AuthServer).initializeServer(this.service, resource, resolve, reject, logger, debug);
    });
  }

  private async ensureAccessTokenWithBrowser(resource: string, logger: Logger, debug: boolean): Promise<AccessToken | null> {
    if (debug) {
      await logger.logToStderr(`Retrieving new access token using interactive browser session...`);
    }

    const response = await this.retrieveAuthCodeWithBrowser(resource, logger, debug);
    if (debug) {
      await logger.logToStderr(`The service returned the code '${response.code}'`);
    }

    return (this.clientApplication as Msal.PublicClientApplication).acquireTokenByCode({
      code: response.code,
      redirectUri: response.redirectUri,
      scopes: [`${resource}/.default`]
    });
  }

  private async ensureAccessTokenSilent(resource: string, logger: Logger, debug: boolean, fetchNew: boolean): Promise<AccessToken | null> {
    if (debug) {
      await logger.logToStderr(`Retrieving new access token silently`);
    }

    const accounts = await (this.clientApplication as Msal.ClientApplication)
      .getTokenCache().getAllAccounts();
    return (this.clientApplication as Msal.ClientApplication).acquireTokenSilent({
      account: accounts[0],
      scopes: [`${resource}/.default`],
      forceRefresh: fetchNew
    });
  }

  private async ensureAccessTokenWithDeviceCode(resource: string, logger: Logger, debug: boolean): Promise<AccessToken | null> {
    if (debug) {
      await logger.logToStderr(`Starting Auth.ensureAccessTokenWithDeviceCode. resource: ${resource}, debug: ${debug}`);
    }

    this.deviceCodeRequest = {
      // deviceCodeCallback is called by MSAL which we're not testing
      /* c8 ignore next 1 */
      deviceCodeCallback: response => this.processDeviceCodeCallback(response, logger, debug),
      scopes: [`${resource}/.default`]
    };
    return (this.clientApplication as Msal.PublicClientApplication).acquireTokenByDeviceCode(this.deviceCodeRequest) as Promise<AccessToken | null>;
  }

  private async processDeviceCodeCallback(response: DeviceCodeResponse, logger: Logger, debug: boolean): Promise<void> {
    if (debug) {
      await logger.logToStderr('Response:');
      await logger.logToStderr(response);
      await logger.logToStderr('');
    }

    const cli = Cli.getInstance();
    cli.spinner.text = response.message;
    cli.spinner.spinner = {
      frames: ['🌶️ ']
    };

    // don't show spinner if running tests
    /* c8 ignore next 3 */
    if (!cli.spinner.isSpinning && typeof global.it === 'undefined') {
      cli.spinner.start();
    }

    if (Cli.getInstance().getSettingWithDefaultValue<boolean>(settingsNames.autoOpenLinksInBrowser, false)) {
      browserUtil.open(response.verificationUri);
    }

    if (Cli.getInstance().getSettingWithDefaultValue<boolean>(settingsNames.copyDeviceCodeToClipboard, false)) {
      // _clipboardy is never set before hitting this line, but this check
      // is implemented so that we can support lazy loading
      // but also stub it for testing
      /* c8 ignore next 3 */
      if (!this._clipboardy) {
        this._clipboardy = (await import('clipboardy')).default;
      }

      this._clipboardy.writeSync(response.userCode);
    }
  }

  private async ensureAccessTokenWithPassword(resource: string, logger: Logger, debug: boolean): Promise<AccessToken | null> {
    if (debug) {
      await logger.logToStderr(`Retrieving new access token using credentials...`);
    }

    return (this.clientApplication as Msal.PublicClientApplication).acquireTokenByUsernamePassword({
      username: this.service.userName as string,
      password: this.service.password as string,
      scopes: [`${resource}/.default`]
    });
  }

  private async ensureAccessTokenWithCertificate(resource: string, logger: Logger, debug: boolean): Promise<AccessToken | null> {
    const nodeForge = (await import('node-forge')).default;
    const { pem, pki, asn1, pkcs12 } = nodeForge;

    if (debug) {
      await logger.logToStderr(`Retrieving new access token using certificate...`);
    }

    let cert: string = '';
    const buf = Buffer.from(this.service.certificate as string, 'base64');

    if (this.service.certificateType === CertificateType.Unknown || this.service.certificateType === CertificateType.Base64) {
      // First time this method is called, we don't know if certificate is PEM or PFX (type is Unknown)
      // We assume it is PEM but when parsing of PEM fails, we assume it could be PFX
      // Type is persisted on service so subsequent calls only run through the correct parsing flow
      try {
        cert = buf.toString('utf8');
        const pemObjs = pem.decode(cert);

        if (this.service.thumbprint === undefined) {
          const pemCertObj = pemObjs.find(pem => pem.type === "CERTIFICATE");
          const pemCertStr: string = pem.encode(pemCertObj!);
          const pemCert = pki.certificateFromPem(pemCertStr);

          this.service.thumbprint = await this.calculateThumbprint(pemCert);
        }
      }
      catch (e) {
        this.service.certificateType = CertificateType.Binary;
      }
    }

    if (this.service.certificateType === CertificateType.Binary) {
      const p12Asn1 = asn1.fromDer(buf.toString('binary'), false);

      const p12Parsed = pkcs12.pkcs12FromAsn1(p12Asn1, false, this.service.password);

      let keyBags: any = p12Parsed.getBags({ bagType: pki.oids.pkcs8ShroudedKeyBag });
      const pkcs8ShroudedKeyBag = keyBags[pki.oids.pkcs8ShroudedKeyBag][0];

      if (debug) {
        // check if there is something in the keyBag as well as
        // the pkcs8ShroudedKeyBag. This will give us more information
        // whether there is a cert that can potentially store keys in the keyBag.
        // I could not find a way to add something to the keyBag with all 
        // my attempts, but lets keep it here for troubleshooting purposes.
        await logger.logToStderr(`pkcs8ShroudedKeyBagkeyBags length is ${[pki.oids.pkcs8ShroudedKeyBag].length}`);

        keyBags = p12Parsed.getBags({ bagType: pki.oids.keyBag });
        await logger.logToStderr(`keyBag length is ${keyBags[pki.oids.keyBag].length}`);
      }

      // convert a Forge private key to an ASN.1 RSAPrivateKey
      const rsaPrivateKey = pki.privateKeyToAsn1(pkcs8ShroudedKeyBag.key);

      // wrap an RSAPrivateKey ASN.1 object in a PKCS#8 ASN.1 PrivateKeyInfo
      const privateKeyInfo = pki.wrapRsaPrivateKey(rsaPrivateKey);

      // convert a PKCS#8 ASN.1 PrivateKeyInfo to PEM
      cert = pki.privateKeyInfoToPem(privateKeyInfo);

      if (this.service.thumbprint === undefined) {
        const certBags = p12Parsed.getBags({ bagType: pki.oids.certBag });
        const certBag = (certBags[pki.oids.certBag]!)[0];

        this.service.thumbprint = await this.calculateThumbprint(certBag.cert!);
      }
    }

    this.clientApplication = await this.getConfidentialClient(logger, debug, this.service.thumbprint as string, cert);
    return (this.clientApplication as Msal.ConfidentialClientApplication).acquireTokenByClientCredential({
      scopes: [`${resource}/.default`]
    });
  }

  private async ensureAccessTokenWithIdentity(resource: string, logger: Logger, debug: boolean): Promise<AccessToken | null> {
    const userName = this.service.userName;
    if (debug) {
      await logger.logToStderr('Will try to retrieve access token using identity...');
    }

    const requestOptions: any = {
      url: '',
      headers: {
        accept: 'application/json',
        Metadata: true,
        'x-anonymous': true
      },
      responseType: 'json'
    };

    if (process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER) {
      if (debug) {
        await logger.logToStderr('IDENTITY_ENDPOINT and IDENTITY_HEADER env variables found it is Azure Function, WebApp...');
      }

      requestOptions.url = `${process.env.IDENTITY_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
      requestOptions.headers['X-IDENTITY-HEADER'] = process.env.IDENTITY_HEADER;
    }
    else if (process.env.MSI_ENDPOINT && process.env.MSI_SECRET) {
      if (debug) {
        await logger.logToStderr('MSI_ENDPOINT and MSI_SECRET env variables found it is Azure Function or WebApp, but using the old names of the env variables...');
      }

      requestOptions.url = `${process.env.MSI_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
      requestOptions.headers['X-IDENTITY-HEADER'] = process.env.MSI_SECRET;
    }
    else if (process.env.IDENTITY_ENDPOINT) {
      if (debug) {
        await logger.logToStderr('IDENTITY_ENDPOINT env variable found it is Azure Could Shell...');
      }

      if (userName && process.env.ACC_CLOUD) {
        // reject for now since the Azure Cloud Shell does not support user-managed identity 
        return Promise.reject('Azure Cloud Shell does not support user-managed identity. You can execute the command without the --userName option to login with user identity');
      }

      requestOptions.url = `${process.env.IDENTITY_ENDPOINT}?resource=${encodeURIComponent(resource)}`;
    }
    else if (process.env.MSI_ENDPOINT) {
      if (debug) {
        await logger.logToStderr('MSI_ENDPOINT env variable found it is Azure Could Shell, but using the old names of the env variables...');
      }

      if (userName && process.env.ACC_CLOUD) {
        // reject for now since the Azure Cloud Shell does not support user-managed identity 
        return Promise.reject('Azure Cloud Shell does not support user-managed identity. You can execute the command without the --userName option to login with user identity');
      }

      requestOptions.url = `${process.env.MSI_ENDPOINT}?resource=${encodeURIComponent(resource)}`;
    }
    else {
      if (debug) {
        await logger.logToStderr('IDENTITY_ENDPOINT and MSI_ENDPOINT env variables not found. Attempt to get Managed Identity token by using the Azure Virtual Machine API...');
      }

      requestOptions.url = `http://169.254.169.254/metadata/identity/oauth2/token?resource=${encodeURIComponent(resource)}&api-version=2018-02-01`;
    }

    if (userName) {
      // if name present then the identity is user-assigned managed identity
      // the name option in this case is either client_id or principal_id (object_id) 
      // of the managed identity service principal
      requestOptions.url += `&client_id=${encodeURIComponent(userName as string)}`;

      if (debug) {
        await logger.logToStderr('Wil try to get token using client_id param...');
      }
    }

    try {
      const accessTokenResponse = await request.get<{ access_token: string; expires_on: string }>(requestOptions);
      return {
        accessToken: accessTokenResponse.access_token,
        expiresOn: new Date(parseInt(accessTokenResponse.expires_on) * 1000)
      };
    }
    catch (e: any) {
      if (!userName) {
        throw e;
      }

      // since the userName option can be either client_id or principal_id (object_id) 
      // and the first attempt was using client_id
      // now lets see if the api returned 'not found' response and
      // try to get token using principal_id (object_id)
      let isNotFoundResponse = false;
      if (e.error && e.error.Message) {
        // check if it is Azure Function api 'not found' response
        isNotFoundResponse = (e.error.Message.indexOf("No Managed Identity found") !== -1);
      }
      else if (e.error && e.error.error_description) {
        // check if it is Azure VM api 'not found' response
        isNotFoundResponse = (e.error.error_description === "Identity not found");
      }

      if (!isNotFoundResponse) {
        // it is not a 'not found' response then exit with error
        throw e;
      }

      if (debug) {
        await logger.logToStderr('Wil try to get token using principal_id (also known as object_id) param ...');
      }

      requestOptions.url = requestOptions.url.replace('&client_id=', '&principal_id=');
      requestOptions.headers['x-anonymous'] = true;

      try {
        const accessTokenResponse = await request.get<{ access_token: string; expires_on: string }>(requestOptions);
        return {
          accessToken: accessTokenResponse.access_token,
          expiresOn: new Date(parseInt(accessTokenResponse.expires_on) * 1000)
        };
      }
      catch (err: any) {
        // will give up and not try any further with the 'msi_res_id' (resource id) query string param
        // since it does not work with the Azure Functions api, but just with the Azure VM api
        if (err.error.code === 'EACCES') {
          // the CLI does not know if managed identity is actually assigned when EACCES code thrown
          // so show meaningful message since the raw error response could be misleading 
          return Promise.reject('Error while logging with Managed Identity. Please check if a Managed Identity is assigned to the current Azure resource.');
        }
        else {
          throw err;
        }
      }
    }
  }

  private async ensureAccessTokenWithSecret(resource: string, logger: Logger, debug: boolean): Promise<AccessToken | null> {
    this.clientApplication = await this.getConfidentialClient(logger, debug, undefined, undefined, this.service.secret);
    return (this.clientApplication as Msal.ConfidentialClientApplication).acquireTokenByClientCredential({
      scopes: [`${resource}/.default`]
    });
  }

  private async calculateThumbprint(certificate: NodeForge.pki.Certificate): Promise<string> {
    const nodeForge = (await import('node-forge')).default;
    const { md, asn1, pki } = nodeForge;

    const messageDigest = md.sha1.create();
    messageDigest.update(asn1.toDer(pki.certificateToAsn1(certificate)).getBytes());
    return messageDigest.digest().toHex();
  }

  public static getResourceFromUrl(url: string): string {
    let resource: string = url;
    const pos: number = resource.indexOf('/', 8);
    if (pos > -1) {
      resource = resource.substr(0, pos);
    }

    if (resource === 'https://api.bap.microsoft.com' ||
      resource === 'https://api.powerapps.com' ||
      resource.endsWith('.api.bap.microsoft.com')) {
      resource = 'https://service.powerapps.com/';
    }

    if (resource === 'https://api.powerbi.com') {
      // api.powerbi.com is not a valid resource
      // we need to use https://analysis.windows.net/powerbi/api instead
      resource = 'https://analysis.windows.net/powerbi/api';
    }

    return resource;
  }

  private async getServiceConnectionInfo<TConn>(): Promise<TConn> {
    const tokenStorage = this.getTokenStorage();
    const json: string = await tokenStorage.get();
    return JSON.parse(json);
  }

  public storeConnectionInfo(): Promise<void> {
    const tokenStorage = this.getTokenStorage();
    return tokenStorage.set(JSON.stringify(this.service));
  }

  public async clearConnectionInfo(): Promise<void> {
    const tokenStorage = this.getTokenStorage();
    await tokenStorage.remove();
    // we need to manually clear MSAL cache, because MSAL doesn't have support
    // for logging out when using cert-based auth
    const msalCache = this.getMsalCacheStorage();
    await msalCache.remove();
  }

  public getTokenStorage(): TokenStorage {
    return new FileTokenStorage(FileTokenStorage.connectionInfoFilePath());
  }

  private getMsalCacheStorage(): TokenStorage {
    return new FileTokenStorage(FileTokenStorage.msalCacheFilePath());
  }

  public static getEndpointForResource(resource: string, cloudType: CloudType): string {
    if (Auth.cloudEndpoints[cloudType] &&
      Auth.cloudEndpoints[cloudType][resource]) {
      return Auth.cloudEndpoints[cloudType][resource];
    }
    else {
      return resource;
    }
  }
}

Auth.initialize();

export default new Auth();