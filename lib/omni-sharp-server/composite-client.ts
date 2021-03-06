import _ = require('lodash');
import {Observable} from 'rx';
import {OmnisharpObservationClient, OmnisharpCombinationClient} from "omnisharp-client";
import Client = require("./client");
import {ViewModel} from './view-model';

export class ObservationClient extends OmnisharpObservationClient<Client> {
    model: typeof ViewModel.prototype.observe;

    constructor(clients: Client[] = []) {
        super(clients);
        
        this.model = {
            codecheck: this.makeMergeObserable((client: Client) => client.model.observe.codecheck),
            output: this.makeMergeObserable((client: Client) => client.model.observe.output),
            status: this.makeMergeObserable((client: Client) => client.model.observe.status),
            updates: this.makeMergeObserable((client: Client) => client.model.observe.updates),
            projectAdded: this.makeMergeObserable((client: Client) => client.model.observe.projectAdded),
            projectRemoved: this.makeMergeObserable((client: Client) => client.model.observe.projectRemoved),
            projectChanged: this.makeMergeObserable((client: Client) => client.model.observe.projectChanged),
            projects: this.makeMergeObserable((client: Client) => client.model.observe.projects)
        };
    }
}
export class CombinationClient extends OmnisharpCombinationClient<Client> { }
