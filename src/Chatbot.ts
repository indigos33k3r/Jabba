import * as bodyParser from 'body-parser';
import * as express from 'express';
import * as mongoose from 'mongoose';
import * as recastai from 'recastai';
import Client from 'recastai';

import { Session } from './Session.model';

export interface IRecastConfig {
  requestToken: string;
  connectToken?: string;
}

export interface IRecastSdk {
  request: recastai.Request;
  connect: recastai.Connect;
}

export interface IMongoConfig {
  hostname: string;
  database: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  replicaSetName?: string;
  port?: string;
  enabled?: boolean;
}

export interface IChatbotConfig extends IRecastConfig {
  language: 'fr' | 'en';
  mongo?: IMongoConfig;
}

export interface IChatbotContext {
  recastSdk: IRecastSdk;
  config: IChatbotConfig;
  message: recastai.Message;
  conversation?: recastai.Conversation;
  session?: Session;
}

export type ChatbotMiddlewareNext = () => Promise<void>;
export type ChatbotMiddleware = (
  ctx: IChatbotContext,
  next?: ChatbotMiddlewareNext
) => Promise<any>;

export default class Chatbot {
  config: IChatbotConfig;
  recastSdk: IRecastSdk;
  httpServer: express.Express;
  middlewarePipeline: ChatbotMiddleware[];

  constructor(config: IChatbotConfig) {
    this.config = config;
    this.middlewarePipeline = [];

    if (config.connectToken) {
      this.recastSdk = {
        connect: new Client(config.connectToken, config.language).connect,
        request: new Client(config.requestToken, config.language).request,
      };
    } else {
      const instance = new Client(config.requestToken, config.language);
      this.recastSdk = {
        connect: instance.connect,
        request: instance.request,
      };
    }

    this.httpServer = express();
    this.httpServer.use(bodyParser.json());
    this.httpServer.post('/', (req, res) =>
      this.recastSdk.connect.handleMessage(req, res, this.onMessage.bind(this))
    );

    // typescripts import are read-only by default
    (mongoose as any).Promise = global.Promise;
    if (this.config.mongo) {
      this.config.mongo.enabled = true;
      this.connectToMongo(this.config.mongo);
    }
  }

  public listen(port: number): Promise<{}> {
    return new Promise((resolve, reject) => {
      this.httpServer.listen(port, (err: any) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

  public use(middleware: ChatbotMiddleware): Chatbot {
    this.middlewarePipeline.push(middleware);
    return this;
  }

  public connectToMongo(config: IMongoConfig): mongoose.MongooseThenable {
    this.config.mongo = config;
    this.config.mongo.enabled = true;
    let auth: string = '';
    if (config.username) {
      auth = `${config.username}:${config.password}@`;
    }

    let connectionString = `mongodb://${auth}${config.hostname}:${config.port}/${config.database}?ssl=${config.ssl}`;
    if (config.replicaSetName) {
      connectionString += `&replicaSet=${config.replicaSetName}`
    }

    return mongoose.connect(
      connectionString,
      { useMongoClient: true }
    );
  }

  public isMongoEnabled(): boolean {
    return this.config.mongo && this.config.mongo.enabled ? true : false;
  }

  public async botHostingEntrypoint(
    body: { message: string; text: string },
    response: object,
    callback: (err: any, data?: any) => void
  ) {
    try {
      if (body.message) {
        this.recastSdk.connect.handleMessage(
          { body },
          response,
          this.onMessage.bind(this)
        );
        callback(null, { result: 'Bot answered :)' });
      } else if (body.text) {
        const res: recastai.Conversation = await this.recastSdk.request.converseText(
          body.text,
          {
            conversationToken: this.config.requestToken,
          }
        );
        if (res && res.reply()) {
          callback(null, {
            reply: res.reply(),
            conversationToken: res.conversationToken,
          });
        } else {
          callback(null, {
            reply: 'No reply :(',
            conversationToken: res.conversationToken,
          });
        }
      } else {
        callback('No text provided');
      }
    } catch (err) {
      callback(err);
    }
  }

  private onMessage(message: recastai.Message): Promise<any> {
    const ctx: IChatbotContext = {
      message,
      recastSdk: this.recastSdk,
      config: this.config,
    };
    let currentMiddlewareIndex: number = 0;

    const execNextMiddleware = (): Promise<any> => {
      const m = this.middlewarePipeline[currentMiddlewareIndex];
      if (m) {
        currentMiddlewareIndex++;
        return m(ctx, execNextMiddleware);
      } else {
        return Promise.resolve();
      }
    };

    if (this.isMongoEnabled() === true) {
      return Session.findOrCreateById(message.conversationId).then((session: Session) => {
        ctx.session = session;
        ctx.session._previousNotUnderstand = ctx.session.consecutiveNotUnderstand;
        ctx.session.consecutiveNotUnderstand = 0;
        session.messageCount++;
        return session.save().then(() => execNextMiddleware());
      });
    }
    return execNextMiddleware();
  }
}
