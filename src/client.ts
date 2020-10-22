import urljoin from 'url-join';
import axios, { AxiosRequestConfig } from 'axios';

type Method = AxiosRequestConfig["method"];

export interface RequestArguments {
    path: string;
    method: Method;
    body?: object;
}

type HeaderDict = { [header: string]: string };

export class Client {
    accessToken: string | null;
    headers: HeaderDict;
    parent?: Client;
    path?: string;

    constructor (arg1?: Client | string, arg2?: string) {
        let parent = undefined;
        let path = undefined;

        if (arguments.length === 2) {
            if (arg1 instanceof Client)
                parent = arg1;

            if (typeof arg2 === "string")
                path = arg2;
        } else if (arguments.length === 1) {
            if (arg1 instanceof Client) {
                parent = arg1;
            } else if (typeof arg1 === "string") {
                path = arg1;
            }
        }

        this.accessToken = null;
        this.headers = {};
        this.parent = parent;
        this.path = path;
    }

    getUrl(path?: string): string {
        if (!path) {
            path = '';
        }

        return urljoin(
            this.parent ? this.parent.getUrl() : '',
            this.path || '',
            path
        );
    }

    setAccessToken (token: string) {
        this.accessToken = token;
    }

    getAccessToken (): string | null {
        if (this.accessToken) {
            return this.accessToken;
        } else if (this.parent) {
            return this.parent.getAccessToken();
        } else {
            return null;
        }
    }

    getHeaders(): HeaderDict {
        let headers: HeaderDict = {};

        if (this.accessToken) {
            headers["Authentication"] = "Bearer " + this.accessToken;
        }

        return Object.assign(
            {},
            this.parent ? this.parent.getHeaders() : {},
            this.headers,
            headers
        );
    }

    async request (args: RequestArguments) {
        let headers = this.getHeaders();
        let body = undefined;

        if (args.body !== undefined) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(args.body);
        }
        
        let res = await axios({
            url: this.getUrl(args.path),
            method: args.method,
            headers,
            data: body,
        });

        return res.data;
    }
}
