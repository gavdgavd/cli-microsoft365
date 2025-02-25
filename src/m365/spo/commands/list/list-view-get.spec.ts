import assert from 'assert';
import sinon from 'sinon';
import auth from '../../../../Auth.js';
import { Cli } from '../../../../cli/Cli.js';
import { CommandInfo } from '../../../../cli/CommandInfo.js';
import { Logger } from '../../../../cli/Logger.js';
import { CommandError } from '../../../../Command.js';
import request from '../../../../request.js';
import { telemetry } from '../../../../telemetry.js';
import { pid } from '../../../../utils/pid.js';
import { session } from '../../../../utils/session.js';
import { sinonUtil } from '../../../../utils/sinonUtil.js';
import commands from '../../commands.js';
import command from './list-view-get.js';
import { settingsNames } from '../../../../settingsNames.js';

describe(commands.LIST_VIEW_GET, () => {
  let cli: Cli;
  let log: string[];
  let logger: Logger;
  let loggerLogSpy: sinon.SinonSpy;
  let commandInfo: CommandInfo;

  before(() => {
    cli = Cli.getInstance();
    sinon.stub(auth, 'restoreAuth').resolves();
    sinon.stub(telemetry, 'trackEvent').returns();
    sinon.stub(pid, 'getProcessName').returns('');
    sinon.stub(session, 'getId').returns('');
    auth.service.connected = true;
    commandInfo = Cli.getCommandInfo(command);
  });

  beforeEach(() => {
    log = [];
    logger = {
      log: async (msg: string) => {
        log.push(msg);
      },
      logRaw: async (msg: string) => {
        log.push(msg);
      },
      logToStderr: async (msg: string) => {
        log.push(msg);
      }
    };
    loggerLogSpy = sinon.spy(logger, 'log');
  });

  afterEach(() => {
    sinonUtil.restore([
      request.get,
      cli.getSettingWithDefaultValue
    ]);
  });

  after(() => {
    sinon.restore();
    auth.service.connected = false;
  });

  it('has correct name', () => {
    assert.strictEqual(command.name, commands.LIST_VIEW_GET);
  });

  it('has a description', () => {
    assert.notStrictEqual(command.description, null);
  });

  it('correctly handles error when the specified list doesn\'t exist', async () => {
    sinon.stub(request, 'get').rejects({
      error: {
        "odata.error": {
          "code": "-2130575322, Microsoft.SharePoint.SPException",
          "message": {
            "lang": "en-US",
            "value": "List does not exist.\n\nThe page you selected contains a list that does not exist. It may have been deleted by another user."
          }
        }
      }
    });

    await assert.rejects(command.action(logger, { options: { webUrl: 'https://contoso.sharepoint.com', listTitle: 'List', title: 'All items' } } as any),
      new CommandError("List does not exist.\n\nThe page you selected contains a list that does not exist. It may have been deleted by another user."));
  });

  it('correctly handles error when the specified view doesn\'t exist', async () => {
    sinon.stub(request, 'get').rejects({
      error: {
        "odata.error": {
          "code": "-2147024809, System.ArgumentException",
          "message": {
            "lang": "en-US",
            "value": "The specified view is invalid."
          }
        }
      }
    });

    await assert.rejects(command.action(logger, { options: { webUrl: 'https://contoso.sharepoint.com', listTitle: 'List', title: 'All Items' } } as any),
      new CommandError("The specified view is invalid."));
  });

  it('should successfully get the list view with specified its Id', async () => {
    sinon.stub(request, 'get').callsFake(async (opts) => {

      if (opts.url === `https://contoso.sharepoint.com/_api/web/lists/getByTitle('List%201')/views/getById('ba84217c-8561-4234-aa95-265081e74be9')`) {
        if (opts.headers &&
          opts.headers.accept &&
          (opts.headers.accept as string).indexOf('application/json') === 0) {
          return { "Aggregations": null, "AggregationsStatus": null, "BaseViewId": "1", "ColumnWidth": null, "ContentTypeId": { "StringValue": "0x" }, "CustomFormatter": null, "DefaultView": true, "DefaultViewForContentType": false, "EditorModified": false, "Formats": null, "Hidden": false, "HtmlSchemaXml": "<View Name=\"{BA84217C-8561-4234-AA95-265081E74BE9}\" DefaultView=\"TRUE\" MobileView=\"TRUE\" MobileDefaultView=\"TRUE\" Type=\"HTML\" DisplayName=\"All Items\" Url=\"/Lists/l2/AllItems.aspx\" Level=\"1\" BaseViewID=\"1\" ContentTypeID=\"0x\" ImageUrl=\"/_layouts/15/images/generic.png?rev=45\"><Toolbar Type=\"Standard\" /><XslLink Default=\"TRUE\">main.xsl</XslLink><JSLink>clienttemplates.js</JSLink><RowLimit Paged=\"TRUE\">30</RowLimit><ViewFields><FieldRef Name=\"LinkTitle\" /></ViewFields><Query><OrderBy><FieldRef Name=\"ID\" /></OrderBy></Query><ParameterBindings><ParameterBinding Name=\"NoAnnouncements\" Location=\"Resource(wss,noXinviewofY_LIST)\" /><ParameterBinding Name=\"NoAnnouncementsHowTo\" Location=\"Resource(wss,noXinviewofY_DEFAULT)\" /></ParameterBindings></View>", "Id": "ba84217c-8561-4234-aa95-265081e74be9", "ImageUrl": "/_layouts/15/images/generic.png?rev=45", "IncludeRootFolder": false, "ViewJoins": null, "JSLink": "clienttemplates.js", "ListViewXml": "<View Name=\"{BA84217C-8561-4234-AA95-265081E74BE9}\" DefaultView=\"TRUE\" MobileView=\"TRUE\" MobileDefaultView=\"TRUE\" Type=\"HTML\" DisplayName=\"All Items\" Url=\"/Lists/l2/AllItems.aspx\" Level=\"1\" BaseViewID=\"1\" ContentTypeID=\"0x\" ImageUrl=\"/_layouts/15/images/generic.png?rev=45\" ><Query><OrderBy><FieldRef Name=\"ID\" /></OrderBy></Query><ViewFields><FieldRef Name=\"LinkTitle\" /></ViewFields><RowLimit Paged=\"TRUE\">30</RowLimit><JSLink>clienttemplates.js</JSLink><XslLink Default=\"TRUE\">main.xsl</XslLink><Toolbar Type=\"Standard\"/></View>", "Method": null, "MobileDefaultView": true, "MobileView": true, "ModerationType": null, "NewDocumentTemplates": null, "OrderedView": false, "Paged": true, "PersonalView": false, "ViewProjectedFields": null, "ViewQuery": "<OrderBy><FieldRef Name=\"ID\" /></OrderBy>", "ReadOnlyView": false, "RequiresClientIntegration": false, "RowLimit": 30, "Scope": 0, "ServerRelativePath": { "DecodedUrl": "/Lists/l2/AllItems.aspx" }, "ServerRelativeUrl": "/Lists/l2/AllItems.aspx", "StyleId": null, "TabularView": true, "Threaded": false, "Title": "All Items", "Toolbar": "", "ToolbarTemplateName": null, "ViewType": "HTML", "ViewData": null, "VisualizationInfo": null };
        }
      }

      throw 'Invalid request';
    });

    await command.action(logger, { options: { webUrl: 'https://contoso.sharepoint.com', listTitle: 'List 1', id: 'ba84217c-8561-4234-aa95-265081e74be9' } });
    assert.strictEqual(loggerLogSpy.lastCall.args[0].Id, 'ba84217c-8561-4234-aa95-265081e74be9');
  });

  it('should successfully get the list view with specified its name', async () => {
    sinon.stub(request, 'get').callsFake(async (opts) => {
      if (opts.url === "https://contoso.sharepoint.com/_api/web/GetList('%2Flists%2FList1')/views/getByTitle('All%20Items')") {
        if (opts.headers &&
          opts.headers.accept &&
          (opts.headers.accept as string).indexOf('application/json') === 0) {
          return { "Aggregations": null, "AggregationsStatus": null, "BaseViewId": "1", "ColumnWidth": null, "ContentTypeId": { "StringValue": "0x" }, "CustomFormatter": null, "DefaultView": true, "DefaultViewForContentType": false, "EditorModified": false, "Formats": null, "Hidden": false, "HtmlSchemaXml": "<View Name=\"{BA84217C-8561-4234-AA95-265081E74BE9}\" DefaultView=\"TRUE\" MobileView=\"TRUE\" MobileDefaultView=\"TRUE\" Type=\"HTML\" DisplayName=\"All Items\" Url=\"/Lists/l2/AllItems.aspx\" Level=\"1\" BaseViewID=\"1\" ContentTypeID=\"0x\" ImageUrl=\"/_layouts/15/images/generic.png?rev=45\"><Toolbar Type=\"Standard\" /><XslLink Default=\"TRUE\">main.xsl</XslLink><JSLink>clienttemplates.js</JSLink><RowLimit Paged=\"TRUE\">30</RowLimit><ViewFields><FieldRef Name=\"LinkTitle\" /></ViewFields><Query><OrderBy><FieldRef Name=\"ID\" /></OrderBy></Query><ParameterBindings><ParameterBinding Name=\"NoAnnouncements\" Location=\"Resource(wss,noXinviewofY_LIST)\" /><ParameterBinding Name=\"NoAnnouncementsHowTo\" Location=\"Resource(wss,noXinviewofY_DEFAULT)\" /></ParameterBindings></View>", "Id": "ba84217c-8561-4234-aa95-265081e74be9", "ImageUrl": "/_layouts/15/images/generic.png?rev=45", "IncludeRootFolder": false, "ViewJoins": null, "JSLink": "clienttemplates.js", "ListViewXml": "<View Name=\"{BA84217C-8561-4234-AA95-265081E74BE9}\" DefaultView=\"TRUE\" MobileView=\"TRUE\" MobileDefaultView=\"TRUE\" Type=\"HTML\" DisplayName=\"All Items\" Url=\"/Lists/l2/AllItems.aspx\" Level=\"1\" BaseViewID=\"1\" ContentTypeID=\"0x\" ImageUrl=\"/_layouts/15/images/generic.png?rev=45\" ><Query><OrderBy><FieldRef Name=\"ID\" /></OrderBy></Query><ViewFields><FieldRef Name=\"LinkTitle\" /></ViewFields><RowLimit Paged=\"TRUE\">30</RowLimit><JSLink>clienttemplates.js</JSLink><XslLink Default=\"TRUE\">main.xsl</XslLink><Toolbar Type=\"Standard\"/></View>", "Method": null, "MobileDefaultView": true, "MobileView": true, "ModerationType": null, "NewDocumentTemplates": null, "OrderedView": false, "Paged": true, "PersonalView": false, "ViewProjectedFields": null, "ViewQuery": "<OrderBy><FieldRef Name=\"ID\" /></OrderBy>", "ReadOnlyView": false, "RequiresClientIntegration": false, "RowLimit": 30, "Scope": 0, "ServerRelativePath": { "DecodedUrl": "/Lists/l2/AllItems.aspx" }, "ServerRelativeUrl": "/Lists/l2/AllItems.aspx", "StyleId": null, "TabularView": true, "Threaded": false, "Title": "All Items", "Toolbar": "", "ToolbarTemplateName": null, "ViewType": "HTML", "ViewData": null, "VisualizationInfo": null };
        }
      }

      throw 'Invalid request';
    });

    await command.action(logger, { options: { webUrl: 'https://contoso.sharepoint.com', listUrl: 'lists/List1', title: 'All Items' } });
    assert.strictEqual(loggerLogSpy.lastCall.args[0].Title, 'All Items');
  });

  it('should successfully get the list view with specified its name and list id', async () => {
    sinon.stub(request, 'get').callsFake(async (opts) => {
      if (opts.url === "https://contoso.sharepoint.com/_api/web/lists(guid'dac05e4a-5f6c-41dd-bba3-2be1104c711e')/views/getById('ba84217c-8561-4234-aa95-265081e74be9')") {
        if (opts.headers &&
          opts.headers.accept &&
          (opts.headers.accept as string).indexOf('application/json') === 0) {
          return { "Aggregations": null, "AggregationsStatus": null, "BaseViewId": "1", "ColumnWidth": null, "ContentTypeId": { "StringValue": "0x" }, "CustomFormatter": null, "DefaultView": true, "DefaultViewForContentType": false, "EditorModified": false, "Formats": null, "Hidden": false, "HtmlSchemaXml": "<View Name=\"{BA84217C-8561-4234-AA95-265081E74BE9}\" DefaultView=\"TRUE\" MobileView=\"TRUE\" MobileDefaultView=\"TRUE\" Type=\"HTML\" DisplayName=\"All Items\" Url=\"/Lists/l2/AllItems.aspx\" Level=\"1\" BaseViewID=\"1\" ContentTypeID=\"0x\" ImageUrl=\"/_layouts/15/images/generic.png?rev=45\"><Toolbar Type=\"Standard\" /><XslLink Default=\"TRUE\">main.xsl</XslLink><JSLink>clienttemplates.js</JSLink><RowLimit Paged=\"TRUE\">30</RowLimit><ViewFields><FieldRef Name=\"LinkTitle\" /></ViewFields><Query><OrderBy><FieldRef Name=\"ID\" /></OrderBy></Query><ParameterBindings><ParameterBinding Name=\"NoAnnouncements\" Location=\"Resource(wss,noXinviewofY_LIST)\" /><ParameterBinding Name=\"NoAnnouncementsHowTo\" Location=\"Resource(wss,noXinviewofY_DEFAULT)\" /></ParameterBindings></View>", "Id": "ba84217c-8561-4234-aa95-265081e74be9", "ImageUrl": "/_layouts/15/images/generic.png?rev=45", "IncludeRootFolder": false, "ViewJoins": null, "JSLink": "clienttemplates.js", "ListViewXml": "<View Name=\"{BA84217C-8561-4234-AA95-265081E74BE9}\" DefaultView=\"TRUE\" MobileView=\"TRUE\" MobileDefaultView=\"TRUE\" Type=\"HTML\" DisplayName=\"All Items\" Url=\"/Lists/l2/AllItems.aspx\" Level=\"1\" BaseViewID=\"1\" ContentTypeID=\"0x\" ImageUrl=\"/_layouts/15/images/generic.png?rev=45\" ><Query><OrderBy><FieldRef Name=\"ID\" /></OrderBy></Query><ViewFields><FieldRef Name=\"LinkTitle\" /></ViewFields><RowLimit Paged=\"TRUE\">30</RowLimit><JSLink>clienttemplates.js</JSLink><XslLink Default=\"TRUE\">main.xsl</XslLink><Toolbar Type=\"Standard\"/></View>", "Method": null, "MobileDefaultView": true, "MobileView": true, "ModerationType": null, "NewDocumentTemplates": null, "OrderedView": false, "Paged": true, "PersonalView": false, "ViewProjectedFields": null, "ViewQuery": "<OrderBy><FieldRef Name=\"ID\" /></OrderBy>", "ReadOnlyView": false, "RequiresClientIntegration": false, "RowLimit": 30, "Scope": 0, "ServerRelativePath": { "DecodedUrl": "/Lists/l2/AllItems.aspx" }, "ServerRelativeUrl": "/Lists/l2/AllItems.aspx", "StyleId": null, "TabularView": true, "Threaded": false, "Title": "All Items", "Toolbar": "", "ToolbarTemplateName": null, "ViewType": "HTML", "ViewData": null, "VisualizationInfo": null };
        }
      }

      throw 'Invalid request';
    });

    await command.action(logger, { options: { debug: true, webUrl: 'https://contoso.sharepoint.com', listId: 'dac05e4a-5f6c-41dd-bba3-2be1104c711e', id: 'ba84217c-8561-4234-aa95-265081e74be9' } });
    assert.strictEqual(loggerLogSpy.lastCall.args[0].Title, 'All Items');
  });

  it('fails validation if webUrl is not a valid SharePoint URL', async () => {
    const actual = await command.validate({ options: { webUrl: 'invalid', listTitle: 'List 1', title: 'All items' } }, commandInfo);
    assert.notStrictEqual(actual, true);
  });

  it('fails validation if neither listId nor listTitle nor listUrl specified', async () => {
    sinon.stub(cli, 'getSettingWithDefaultValue').callsFake((settingName, defaultValue) => {
      if (settingName === settingsNames.prompt) {
        return false;
      }

      return defaultValue;
    });

    const actual = await command.validate({ options: { webUrl: 'https://contoso.sharepoint.com', title: 'All items' } }, commandInfo);
    assert.notStrictEqual(actual, true);
  });

  it('fails validation if listId is not a GUID', async () => {
    const actual = await command.validate({ options: { webUrl: 'https://contoso.sharepoint.com', listId: 'invalid', title: 'All items' } }, commandInfo);
    assert.notStrictEqual(actual, true);
  });

  it('fails validation if neither id nor title specified', async () => {
    sinon.stub(cli, 'getSettingWithDefaultValue').callsFake((settingName, defaultValue) => {
      if (settingName === settingsNames.prompt) {
        return false;
      }

      return defaultValue;
    });

    const actual = await command.validate({ options: { webUrl: 'https://contoso.sharepoint.com', listTitle: 'List 1' } }, commandInfo);
    assert.notStrictEqual(actual, true);
  });

  it('fails validation if both id and title specified', async () => {
    sinon.stub(cli, 'getSettingWithDefaultValue').callsFake((settingName, defaultValue) => {
      if (settingName === settingsNames.prompt) {
        return false;
      }

      return defaultValue;
    });

    const actual = await command.validate({ options: { webUrl: 'https://contoso.sharepoint.com', listTitle: 'List 1', id: '330f29c5-5c4c-465f-9f4b-7903020ae1ce', title: 'All items' } }, commandInfo);
    assert.notStrictEqual(actual, true);
  });

  it('fails validation if id is not a GUID', async () => {
    const actual = await command.validate({ options: { webUrl: 'https://contoso.sharepoint.com', listTitle: 'List 1', id: 'invalid' } }, commandInfo);
    assert.notStrictEqual(actual, true);
  });

  it('passes validation when title and listTitle specified', async () => {
    const actual = await command.validate({ options: { webUrl: 'https://contoso.sharepoint.com', listTitle: 'List 1', title: 'All items' } }, commandInfo);
    assert.strictEqual(actual, true);
  });

  it('passes validation when id and listId specified and valid GUIDs', async () => {
    const actual = await command.validate({ options: { webUrl: 'https://contoso.sharepoint.com', listId: '330f29c5-5c4c-465f-9f4b-7903020ae1ce', id: '330f29c5-5c4c-465f-9f4b-7903020ae1cf' } }, commandInfo);
    assert.strictEqual(actual, true);
  });

  it('passes validation when id and listUrl specified', async () => {
    const actual = await command.validate({ options: { webUrl: 'https://contoso.sharepoint.com', listUrl: 'lists/list1', id: '330f29c5-5c4c-465f-9f4b-7903020ae1cf' } }, commandInfo);
    assert.strictEqual(actual, true);
  });
});
